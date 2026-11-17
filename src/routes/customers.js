const express = require('express');
const ExcelJS = require('exceljs');
const { db, runTransaction } = require('../db/database');
const { requireAuth, auditLog } = require('../middleware/auth');
const { parseSpreadsheetBuffer, mapCustomerRow } = require('../services/importer');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
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
  const rows = db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM withdrawals w WHERE w.customer_id = c.id AND w.status = 'aberta') AS open_withdrawals_count
       FROM customers c
       ${where}
       ORDER BY c.name ASC`
    )
    .all(...params);

  // Attach authorized people
  const peopleRows = db
    .prepare('SELECT * FROM customer_authorized_people WHERE active = 1 ORDER BY name ASC')
    .all();
  const byCustomer = new Map();
  for (const p of peopleRows) {
    if (!byCustomer.has(p.customer_id)) byCustomer.set(p.customer_id, []);
    byCustomer.get(p.customer_id).push(p);
  }

  const result = rows.map((c) => ({
    ...c,
    authorized_people: byCustomer.get(c.id) || [],
  }));

  res.json(result);
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

router.post('/import', async (req, res) => {
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

  runTransaction(() => {
    const findByDoc = db.prepare("SELECT id FROM customers WHERE document = ? AND document != ''");
    const findByName = db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)');
    const insertStmt = db.prepare(
      `INSERT INTO customers (name, document, phone, address, notes, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const updateStmt = db.prepare(
      `UPDATE customers
       SET name = ?, document = ?, phone = ?, address = ?, notes = ?, status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    );

    rawRows.forEach((raw, idx) => {
      const lineNum = idx + 2;
      const c = mapCustomerRow(raw);
      if (!c.name) {
        skipped++;
        errors.push(`Linha ${lineNum}: nome do cliente é obrigatório.`);
        return;
      }

      const existing =
        (c.document ? findByDoc.get(c.document) : null) || findByName.get(c.name);

      if (existing) {
        if (updateExisting) {
          updateStmt.run(c.name, c.document, c.phone, c.address, c.notes, c.status, existing.id);
          updated++;
        } else {
          skipped++;
        }
      } else {
        insertStmt.run(c.name, c.document, c.phone, c.address, c.notes, c.status);
        created++;
      }
    });

    auditLog({
      user: req.user,
      action: 'IMPORT_CUSTOMERS',
      entity: 'customers',
      details: { filename, created, updated, skipped },
    });
  });

  res.json({ total: rawRows.length, created, updated, skipped, errors: errors.slice(0, 20) });
});

router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!customer) {
    return res.status(404).json({ error: 'Cliente não encontrado.' });
  }
  const authorized_people = db
    .prepare('SELECT * FROM customer_authorized_people WHERE customer_id = ? ORDER BY active DESC, name ASC')
    .all(customer.id);
  res.json({ ...customer, authorized_people });
});

router.post('/', (req, res) => {
  const { name, document = '', phone = '', address = '', notes = '', status = 'ativo', authorized_people = [] } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nome ou razão social é obrigatório.' });
  }
  const validStatus = status === 'inativo' ? 'inativo' : 'ativo';

  const info = db
    .prepare(
      `INSERT INTO customers (name, document, phone, address, notes, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(name).trim(),
      String(document || '').trim(),
      String(phone || '').trim(),
      String(address || '').trim(),
      String(notes || '').trim(),
      validStatus
    );

  const customerId = Number(info.lastInsertRowid);

  if (Array.isArray(authorized_people)) {
    const stmt = db.prepare(
      'INSERT INTO customer_authorized_people (customer_id, name, identification) VALUES (?, ?, ?)'
    );
    for (const person of authorized_people) {
      if (person && String(person.name || '').trim()) {
        stmt.run(customerId, String(person.name).trim(), String(person.identification || '').trim());
      }
    }
  }

  auditLog({
    user: req.user,
    action: 'CREATE',
    entity: 'customers',
    entityId: customerId,
    details: { name: String(name).trim() },
  });

  const created = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  const people = db
    .prepare('SELECT * FROM customer_authorized_people WHERE customer_id = ?')
    .all(customerId);
  res.status(201).json({ ...created, authorized_people: people });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Cliente não encontrado.' });
  }

  const { name, document = '', phone = '', address = '', notes = '', status = 'ativo' } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nome ou razão social é obrigatório.' });
  }
  const validStatus = status === 'inativo' ? 'inativo' : 'ativo';

  db.prepare(
    `UPDATE customers
     SET name = ?, document = ?, phone = ?, address = ?, notes = ?, status = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    String(name).trim(),
    String(document || '').trim(),
    String(phone || '').trim(),
    String(address || '').trim(),
    String(notes || '').trim(),
    validStatus,
    id
  );

  auditLog({
    user: req.user,
    action: 'UPDATE',
    entity: 'customers',
    entityId: id,
    details: { before: existing.name, after: String(name).trim(), status: validStatus },
  });

  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  const people = db
    .prepare('SELECT * FROM customer_authorized_people WHERE customer_id = ? ORDER BY active DESC, name ASC')
    .all(id);
  res.json({ ...updated, authorized_people: people });
});

router.post('/:id/authorized-people', (req, res) => {
  const customerId = Number(req.params.id);
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Cliente não encontrado.' });
  }

  const { name, identification = '' } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nome da pessoa autorizada é obrigatório.' });
  }

  const info = db
    .prepare('INSERT INTO customer_authorized_people (customer_id, name, identification) VALUES (?, ?, ?)')
    .run(customerId, String(name).trim(), String(identification || '').trim());

  auditLog({
    user: req.user,
    action: 'ADD_AUTHORIZED_PERSON',
    entity: 'customer_authorized_people',
    entityId: info.lastInsertRowid,
    details: { customerId, name: String(name).trim() },
  });

  const person = db
    .prepare('SELECT * FROM customer_authorized_people WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  res.status(201).json(person);
});

router.delete('/:id/authorized-people/:personId', (req, res) => {
  const customerId = Number(req.params.id);
  const personId = Number(req.params.personId);
  const person = db
    .prepare('SELECT * FROM customer_authorized_people WHERE id = ? AND customer_id = ?')
    .get(personId, customerId);
  if (!person) {
    return res.status(404).json({ error: 'Pessoa autorizada não encontrada.' });
  }

  db.prepare('UPDATE customer_authorized_people SET active = 0 WHERE id = ?').run(personId);
  auditLog({
    user: req.user,
    action: 'REMOVE_AUTHORIZED_PERSON',
    entity: 'customer_authorized_people',
    entityId: personId,
    details: { customerId, name: person.name },
  });
  res.json({ ok: true });
});

module.exports = router;
