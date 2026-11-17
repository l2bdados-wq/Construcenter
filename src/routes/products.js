const express = require('express');
const ExcelJS = require('exceljs');
const { db, runTransaction } = require('../db/database');
const { requireAuth, auditLog } = require('../middleware/auth');
const { parseCurrencyToCents } = require('../utils/format');
const { parseSpreadsheetBuffer, mapProductRow } = require('../services/importer');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { q = '', status = '' } = req.query;
    const conditions = [];
    const params = [];

    if (q.trim()) {
      conditions.push(
        '(internal_code LIKE ? OR barcode LIKE ? OR description LIKE ? OR brand LIKE ? OR category LIKE ?)'
      );
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like, like);
    }
    if (status === 'ativo' || status === 'inativo') {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(`SELECT * FROM products ${where} ORDER BY description ASC`, ...params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/import/template', async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Produtos');
  sheet.columns = [
    { header: 'Codigo Interno', key: 'internal_code', width: 18 },
    { header: 'Codigo de Barras', key: 'barcode', width: 20 },
    { header: 'Descricao', key: 'description', width: 40 },
    { header: 'Marca', key: 'brand', width: 18 },
    { header: 'Categoria', key: 'category', width: 18 },
    { header: 'Unidade', key: 'unit', width: 14 },
    { header: 'Preco de Venda', key: 'price', width: 16 },
    { header: 'Situacao', key: 'status', width: 12 },
  ];
  sheet.addRow({
    internal_code: 'CABO25',
    barcode: '7891234567890',
    description: 'Cabo Flexível 2,5mm Preto',
    brand: 'Sil',
    category: 'Fios e Cabos',
    unit: 'metro',
    price: 3.5,
    status: 'ativo',
  });
  sheet.getRow(1).font = { bold: true };
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="modelo_produtos_construcenter.xlsx"');
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
        const p = mapProductRow(rawRows[idx]);
        if (!p.internal_code || !p.description) {
          skipped++;
          errors.push(`Linha ${lineNum}: código interno e descrição são obrigatórios.`);
          continue;
        }
        if (!Number.isInteger(p.price_cents) || p.price_cents < 0) {
          skipped++;
          errors.push(`Linha ${lineNum} (${p.internal_code}): preço inválido.`);
          continue;
        }

        const existing = await db.get('SELECT id FROM products WHERE internal_code = ?', p.internal_code);
        if (existing) {
          if (updateExisting) {
            await db.run(
              `UPDATE products
               SET barcode = ?, description = ?, brand = ?, category = ?, unit = ?, price_cents = ?, status = ?, updated_at = datetime('now', 'localtime')
               WHERE id = ?`,
              p.barcode, p.description, p.brand, p.category, p.unit, p.price_cents, p.status, existing.id
            );
            updated++;
          } else {
            skipped++;
          }
        } else {
          await db.run(
            `INSERT INTO products (internal_code, barcode, description, brand, category, unit, price_cents, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            p.internal_code, p.barcode, p.description, p.brand, p.category, p.unit, p.price_cents, p.status
          );
          created++;
        }
      }

      await auditLog({
        user: req.user,
        action: 'IMPORT_PRODUCTS',
        entity: 'products',
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
    const product = await db.get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      internal_code,
      barcode = '',
      description,
      brand = '',
      category = '',
      unit = 'unidade',
      price,
      price_cents,
      status = 'ativo',
    } = req.body || {};

    if (!internal_code || !String(internal_code).trim()) {
      return res.status(400).json({ error: 'Código interno é obrigatório.' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Descrição do produto é obrigatória.' });
    }

    const cents =
      typeof price_cents === 'number' && Number.isInteger(price_cents)
        ? price_cents
        : parseCurrencyToCents(price);

    if (!Number.isInteger(cents) || cents < 0) {
      return res.status(400).json({ error: 'Preço de venda inválido.' });
    }

    const validStatus = status === 'inativo' ? 'inativo' : 'ativo';
    const code = String(internal_code).trim();

    const dup = await db.get('SELECT id FROM products WHERE internal_code = ?', code);
    if (dup) {
      return res.status(409).json({ error: `Já existe um produto com o código interno "${code}".` });
    }

    const info = await db.run(
      `INSERT INTO products (internal_code, barcode, description, brand, category, unit, price_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      String(barcode || '').trim(),
      String(description).trim(),
      String(brand || '').trim(),
      String(category || '').trim(),
      String(unit || 'unidade').trim(),
      cents,
      validStatus
    );

    const productId = info.lastInsertRowid;
    await auditLog({
      user: req.user,
      action: 'CREATE',
      entity: 'products',
      entityId: productId,
      details: { internal_code: code, description: String(description).trim(), price_cents: cents },
    });

    const created = await db.get('SELECT * FROM products WHERE id = ?', productId);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM products WHERE id = ?', id);
    if (!existing) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    const {
      internal_code,
      barcode = '',
      description,
      brand = '',
      category = '',
      unit = 'unidade',
      price,
      price_cents,
      status = 'ativo',
    } = req.body || {};

    if (!internal_code || !String(internal_code).trim()) {
      return res.status(400).json({ error: 'Código interno é obrigatório.' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Descrição do produto é obrigatória.' });
    }

    const cents =
      typeof price_cents === 'number' && Number.isInteger(price_cents)
        ? price_cents
        : parseCurrencyToCents(price);

    if (!Number.isInteger(cents) || cents < 0) {
      return res.status(400).json({ error: 'Preço de venda inválido.' });
    }

    const validStatus = status === 'inativo' ? 'inativo' : 'ativo';
    const code = String(internal_code).trim();

    const dup = await db.get('SELECT id FROM products WHERE internal_code = ? AND id != ?', code, id);
    if (dup) {
      return res.status(409).json({ error: `Já existe outro produto com o código interno "${code}".` });
    }

    await db.run(
      `UPDATE products
       SET internal_code = ?, barcode = ?, description = ?, brand = ?, category = ?, unit = ?, price_cents = ?, status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      code,
      String(barcode || '').trim(),
      String(description).trim(),
      String(brand || '').trim(),
      String(category || '').trim(),
      String(unit || 'unidade').trim(),
      cents,
      validStatus,
      id
    );

    await auditLog({
      user: req.user,
      action: 'UPDATE',
      entity: 'products',
      entityId: id,
      details: {
        before_price_cents: existing.price_cents,
        after_price_cents: cents,
        internal_code: code,
      },
    });

    const updated = await db.get('SELECT * FROM products WHERE id = ?', id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
