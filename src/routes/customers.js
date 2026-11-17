const express = require('express');
const ExcelJS = require('exceljs');
const { db, runTransaction } = require('../db/database');
const { requireAuth, auditLog } = require('../middleware/auth');
const { parseSpreadsheetBuffer, mapCustomerRow } = require('../services/importer');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { q = '', status = '' } = req.query;
    const conditions = [];
    const params = [];

    if (q.trim()) {
      conditions.push('(c.name LIKE ? OR c.document LIKE ? OR c.phone LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    if (status === 'ativo' || status === 'inativo') {
      conditions.push('c.status = ?');
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT c.*,
        (SELECT COUNT(*) FROM withdrawals w WHERE w.customer_id = c.id AND w.status = 'aberta') AS open_withdrawals_count
       FROM customers c
       ${where}
       ORDER BY c.name ASC`,
      ...params
    );

    const peopleRows = await db.all(
      'SELECT * FROM customer_authorized_people WHERE active = 1 ORDER BY name ASC'
    );
    const byCustomer = new Map();
    for (const p of peopleRows) {
      if (!byCustomer.has(p.customer_id)) byCustomer.set(p.customer_id, []);
      byCustomer.get(p.customer_id).push(p);
    }

    res.json(
      rows.map((c) => ({
        ...c,
        authorized_people: byCustomer.get(c.id) || [],
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get('/import/template', async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Clientes');
  sheet.columns = [
    { header: 'Nome ou Razao Social', key: 'name', width: 35 },
    { header: 'CPF/CNPJ', key: 'document', width: 20 },
    { header: 'Telefone/WhatsApp', key: 'phone', width: 20 },
    { header: 'Endereco', key: 'address', width: 35 },
    { header: 'Observacoes', key: 'notes', width: 25 },
    { header: 'Situacao', key: 'status', width: 12 },
  ];
  sheet.addRow({
    name: 'Lucas Silva Construções',
    document: '123.456.789-00',
    phone: '(77) 99999-1111',
    address: 'Rua das Flores, 100',
    notes: 'Cliente mensalista',
    status: 'ativo',
  });
  sheet.getRow(1).font = { bold: true };
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="modelo_clientes_construcenter.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

router.post('/import', async (req, res, next) => {
  try {
    const { filename, contentBase64, updateExisting = true } = req.body || {};
    if (!contentBase64) {
      return res.status(400).json({ error: 'Arquivo não enviado.' });
    }

    const buffer = Buffer.from(contentBase64, 'base64');
    const rawRows = await parseSpreadsheetBuffer(filename, buffer);
    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma linha encontrada na planilha.' });
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    await runTransaction(async () => {
      for (let idx = 0; idx < rawRows.length; idx++) {
        const lineNum = idx + 2;
        const c = mapCustomerRow(rawRows[idx]);
        if (!c.name) {
          skipped++;
          errors.push(`Linha ${lineNum}: nome do cliente é obrigatório.`);
          continue;
        }

        let existing = null;
        if (c.document) {
          existing = await db.get("SELECT id FROM customers WHERE document = ? AND document != ''", c.document);
        }
        if (!existing) {
          existing = await db.get('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)', c.name);
        }

        if (existing) {
          if (updateExisting) {
            await db.run(
              `UPDATE customers
               SET name = ?, document = ?, phone = ?, address = ?, notes = ?, status = ?, updated_at = datetime('now', 'localtime')
               WHERE id = ?`,
              c.name, c.document, c.phone, c.address, c.notes, c.status, existing.id
            );
            updated++;
          } else {
            skipped++;
          }
        } else {
          await db.run(
            `INSERT INTO customers (name, document, phone, address, notes, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            c.name, c.document, c.phone, c.address, c.notes, c.status
          );
          created++;
        }
      }

      await auditLog({
        user: req.user,
        action: 'IMPORT_CUSTOMERS',
        entity: 'customers',
        details: { filename, created, updated, skipped },
      });
    });

    res.json({ total: rawRows.length, created, updated, skipped, errors: errors.slice(0, 20) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(req.params.id));
    if (!customer) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const authorized_people = await db.all(
      'SELECT * FROM customer_authorized_people WHERE customer_id = ? ORDER BY active DESC, name ASC',
      customer.id
    );
    res.json({ ...customer, authorized_people });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, document = '', phone = '', address = '', notes = '', status = 'ativo', authorized_people = [] } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Nome ou razão social é obrigatório.' });
    }
    const validStatus = status === 'inativo' ? 'inativo' : 'ativo';

    const info = await db.run(
      `INSERT INTO customers (name, document, phone, address, notes, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      String(name).trim(),
      String(document || '').trim(),
      String(phone || '').trim(),
      String(address || '').trim(),
      String(notes || '').trim(),
      validStatus
    );

    const customerId = info.lastInsertRowid;

    if (Array.isArray(authorized_people)) {
      for (const person of authorized_people) {
        if (person && String(person.name || '').trim()) {
          await db.run(
            'INSERT INTO customer_authorized_people (customer_id, name, identification) VALUES (?, ?, ?)',
            customerId,
            String(person.name).trim(),
            String(person.identification || '').trim()
          );
        }
      }
    }

    await auditLog({
      user: req.user,
      action: 'CREATE',
      entity: 'customers',
      entityId: customerId,
      details: { name: String(name).trim() },
    });

    const created = await db.get('SELECT * FROM customers WHERE id = ?', customerId);
    const people = await db.all(
      'SELECT * FROM customer_authorized_people WHERE customer_id = ?',
      customerId
    );
    res.status(201).json({ ...created, authorized_people: people });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM customers WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const { name, document = '', phone = '', address = '', notes = '', status = 'ativo' } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Nome ou razão social é obrigatório.' });
    }
    const validStatus = status === 'inativo' ? 'inativo' : 'ativo';

    await db.run(
      `UPDATE customers
       SET name = ?, document = ?, phone = ?, address = ?, notes = ?, status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      String(name).trim(),
      String(document || '').trim(),
      String(phone || '').trim(),
      String(address || '').trim(),
      String(notes || '').trim(),
      validStatus,
      id
    );

    await auditLog({
      user: req.user,
      action: 'UPDATE',
      entity: 'customers',
      entityId: id,
      details: { before: existing.name, after: String(name).trim(), status: validStatus },
    });

    const updated = await db.get('SELECT * FROM customers WHERE id = ?', id);
    const people = await db.all(
      'SELECT * FROM customer_authorized_people WHERE customer_id = ? ORDER BY active DESC, name ASC',
      id
    );
    res.json({ ...updated, authorized_people: people });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/authorized-people', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await db.get('SELECT id FROM customers WHERE id = ?', customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const { name, identification = '' } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Nome da pessoa autorizada é obrigatório.' });
    }

    const info = await db.run(
      'INSERT INTO customer_authorized_people (customer_id, name, identification) VALUES (?, ?, ?)',
      customerId,
      String(name).trim(),
      String(identification || '').trim()
    );

    await auditLog({
      user: req.user,
      action: 'ADD_AUTHORIZED_PERSON',
      entity: 'customer_authorized_people',
      entityId: info.lastInsertRowid,
      details: { customerId, name: String(name).trim() },
    });

    const person = await db.get(
      'SELECT * FROM customer_authorized_people WHERE id = ?',
      info.lastInsertRowid
    );
    res.status(201).json(person);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/authorized-people/:personId', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const personId = Number(req.params.personId);
    const person = await db.get(
      'SELECT * FROM customer_authorized_people WHERE id = ? AND customer_id = ?',
      personId,
      customerId
    );
    if (!person) {
      return res.status(404).json({ error: 'Pessoa autorizada não encontrada.' });
    }

    await db.run('UPDATE customer_authorized_people SET active = 0 WHERE id = ?', personId);
    await auditLog({
      user: req.user,
      action: 'REMOVE_AUTHORIZED_PERSON',
      entity: 'customer_authorized_people',
      entityId: personId,
      details: { customerId, name: person.name },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
