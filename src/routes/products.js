const express = require('express');
const ExcelJS = require('exceljs');
const { db, runTransaction } = require('../db/database');
const { requireAuth, auditLog } = require('../middleware/auth');
const { parseCurrencyToCents } = require('../utils/format');
const { parseSpreadsheetBuffer, mapProductRow } = require('../services/importer');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
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
  const rows = db
    .prepare(`SELECT * FROM products ${where} ORDER BY description ASC`)
    .all(...params);
  res.json(rows);
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
    const findStmt = db.prepare('SELECT id FROM products WHERE internal_code = ?');
    const insertStmt = db.prepare(
      `INSERT INTO products (internal_code, barcode, description, brand, category, unit, price_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateStmt = db.prepare(
      `UPDATE products
       SET barcode = ?, description = ?, brand = ?, category = ?, unit = ?, price_cents = ?, status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    );

    rawRows.forEach((raw, idx) => {
      const lineNum = idx + 2;
      const p = mapProductRow(raw);
      if (!p.internal_code || !p.description) {
        skipped++;
        errors.push(`Linha ${lineNum}: código interno e descrição são obrigatórios.`);
        return;
      }
      if (!Number.isInteger(p.price_cents) || p.price_cents < 0) {
        skipped++;
        errors.push(`Linha ${lineNum} (${p.internal_code}): preço inválido.`);
        return;
      }

      const existing = findStmt.get(p.internal_code);
      if (existing) {
        if (updateExisting) {
          updateStmt.run(
            p.barcode,
            p.description,
            p.brand,
            p.category,
            p.unit,
            p.price_cents,
            p.status,
            existing.id
          );
          updated++;
        } else {
          skipped++;
        }
      } else {
        insertStmt.run(
          p.internal_code,
          p.barcode,
          p.description,
          p.brand,
          p.category,
          p.unit,
          p.price_cents,
          p.status
        );
        created++;
      }
    });

    auditLog({
      user: req.user,
      action: 'IMPORT_PRODUCTS',
      entity: 'products',
      details: { filename, created, updated, skipped },
    });
  });

  res.json({ total: rawRows.length, created, updated, skipped, errors: errors.slice(0, 20) });
});

router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado.' });
  }
  res.json(product);
});

router.post('/', (req, res) => {
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

  const dup = db.prepare('SELECT id FROM products WHERE internal_code = ?').get(code);
  if (dup) {
    return res.status(409).json({ error: `Já existe um produto com o código interno "${code}".` });
  }

  const info = db
    .prepare(
      `INSERT INTO products (internal_code, barcode, description, brand, category, unit, price_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      String(barcode || '').trim(),
      String(description).trim(),
      String(brand || '').trim(),
      String(category || '').trim(),
      String(unit || 'unidade').trim(),
      cents,
      validStatus
    );

  const productId = Number(info.lastInsertRowid);
  auditLog({
    user: req.user,
    action: 'CREATE',
    entity: 'products',
    entityId: productId,
    details: { internal_code: code, description: String(description).trim(), price_cents: cents },
  });

  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  res.status(201).json(created);
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
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

  const dup = db
    .prepare('SELECT id FROM products WHERE internal_code = ? AND id != ?')
    .get(code, id);
  if (dup) {
    return res.status(409).json({ error: `Já existe outro produto com o código interno "${code}".` });
  }

  db.prepare(
    `UPDATE products
     SET internal_code = ?, barcode = ?, description = ?, brand = ?, category = ?, unit = ?, price_cents = ?, status = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
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

  auditLog({
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

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.json(updated);
});

module.exports = router;
