const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { enrichWithdrawals } = require('./withdrawals');
const { generateReportPDF } = require('../services/pdf');
const { formatCents, formatQuantity, formatDateTimeBR, formatDateBR } = require('../utils/format');

const router = express.Router();
router.use(requireAuth);

router.get('/dashboard', (req, res) => {
  const openRows = db
    .prepare(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone
       FROM withdrawals w
       JOIN customers c ON c.id = w.customer_id
       WHERE w.status = 'aberta'
       ORDER BY w.withdrawal_date DESC`
    )
    .all();

  const openEnriched = enrichWithdrawals(openRows);
  const open_total_cents = openEnriched.reduce((acc, w) => acc + w.net_total_cents, 0);

  const byCustomer = new Map();
  for (const w of openEnriched) {
    if (!byCustomer.has(w.customer_id)) {
      byCustomer.set(w.customer_id, {
        customer_id: w.customer_id,
        customer_name: w.customer_name,
        customer_phone: w.customer_phone,
        open_count: 0,
        open_total_cents: 0,
      });
    }
    const c = byCustomer.get(w.customer_id);
    c.open_count += 1;
    c.open_total_cents += w.net_total_cents;
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const monthStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  const today_withdrawals_count = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM withdrawals WHERE substr(withdrawal_date, 1, 10) = ? AND status != 'cancelada'"
    )
    .get(todayStr).cnt;

  const month_orders_count = db
    .prepare("SELECT COUNT(*) AS cnt FROM orders WHERE substr(issued_at, 1, 7) = ?")
    .get(monthStr).cnt;

  const recentRows = db
    .prepare(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone,
              o.order_number
       FROM withdrawals w
       JOIN customers c ON c.id = w.customer_id
       LEFT JOIN orders o ON o.id = w.order_id
       ORDER BY w.id DESC
       LIMIT 8`
    )
    .all();

  res.json({
    kpis: {
      open_total_cents,
      pending_customers_count: byCustomer.size,
      today_withdrawals_count,
      month_orders_count,
    },
    pending_customers: Array.from(byCustomer.values()).sort(
      (a, b) => b.open_total_cents - a.open_total_cents
    ),
    recent_withdrawals: enrichWithdrawals(recentRows),
  });
});

function buildReportData({ type = 'customer', start_date, end_date, customer_id, status }) {
  const conditions = ["w.status != 'cancelada'"];
  const params = [];

  if (status && ['aberta', 'fechada', 'cancelada'].includes(status)) {
    conditions.shift();
    conditions.push('w.status = ?');
    params.push(status);
  }
  if (start_date) {
    conditions.push('substr(w.withdrawal_date, 1, 10) >= ?');
    params.push(start_date);
  }
  if (end_date) {
    conditions.push('substr(w.withdrawal_date, 1, 10) <= ?');
    params.push(end_date);
  }
  if (customer_id) {
    conditions.push('w.customer_id = ?');
    params.push(Number(customer_id));
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone,
              o.order_number
       FROM withdrawals w
       JOIN customers c ON c.id = w.customer_id
       LEFT JOIN orders o ON o.id = w.order_id
       ${where}
       ORDER BY w.withdrawal_date DESC, w.id DESC`
    )
    .all(...params);

  const enriched = enrichWithdrawals(rows);

  if (type === 'product') {
    const map = new Map();
    for (const w of enriched) {
      for (const item of w.items) {
        const key = `${item.product_code}::${item.product_unit}`;
        if (!map.has(key)) {
          map.set(key, {
            product_code: item.product_code,
            product_description: item.product_description,
            product_unit: item.product_unit,
            total_qty: 0,
            total_cents: 0,
            withdrawals_count: 0,
          });
        }
        const entry = map.get(key);
        entry.total_qty = Math.round((entry.total_qty + item.quantity) * 1000) / 1000;
        entry.total_cents += item.subtotal_cents;
        entry.withdrawals_count += 1;
      }
    }
    const items = Array.from(map.values()).sort((a, b) => b.total_cents - a.total_cents);
    return { type, items, total_cents: items.reduce((a, b) => a + b.total_cents, 0) };
  }

  if (type === 'customer') {
    const map = new Map();
    for (const w of enriched) {
      if (!map.has(w.customer_id)) {
        map.set(w.customer_id, {
          customer_id: w.customer_id,
          customer_name: w.customer_name,
          open_count: 0,
          closed_count: 0,
          open_cents: 0,
          closed_cents: 0,
          total_cents: 0,
        });
      }
      const entry = map.get(w.customer_id);
      if (w.status === 'aberta') {
        entry.open_count += 1;
        entry.open_cents += w.net_total_cents;
      } else if (w.status === 'fechada') {
        entry.closed_count += 1;
        entry.closed_cents += w.net_total_cents;
      }
      entry.total_cents += w.net_total_cents;
    }
    const items = Array.from(map.values()).sort((a, b) => b.total_cents - a.total_cents);
    return { type, items, total_cents: items.reduce((a, b) => a + b.total_cents, 0) };
  }

  // 'period' -> list withdrawals
  return {
    type: 'period',
    items: enriched,
    total_cents: enriched.reduce((a, w) => a + w.net_total_cents, 0),
  };
}

router.get('/data', (req, res) => {
  const result = buildReportData(req.query);
  res.json(result);
});

router.get('/export/pdf', (req, res) => {
  const data = buildReportData(req.query);
  const store = db.prepare('SELECT * FROM store_settings WHERE id = 1').get();
  const periodLabel =
    req.query.start_date || req.query.end_date
      ? `Período: ${req.query.start_date ? formatDateBR(req.query.start_date) : 'Início'} a ${req.query.end_date ? formatDateBR(req.query.end_date) : 'Hoje'}`
      : 'Todo o período';

  if (data.type === 'product') {
    return generateReportPDF(
      {
        title: 'RELATÓRIO POR PRODUTO',
        subtitle: periodLabel,
        store,
        columns: [
          { text: 'Código', x: 45, w: 70 },
          { text: 'Produto', x: 118, w: 215 },
          { text: 'Unid.', x: 335, w: 45, align: 'center' },
          { text: 'Qtd. Total', x: 382, w: 60, align: 'right' },
          { text: 'Movs.', x: 445, w: 35, align: 'right' },
          { text: 'Total', x: 482, w: 68, align: 'right' },
        ],
        rows: data.items.map((it) => [
          it.product_code,
          it.product_description,
          it.product_unit,
          formatQuantity(it.total_qty),
          String(it.withdrawals_count),
          formatCents(it.total_cents),
        ]),
        summaryLines: [`Total Geral: ${formatCents(data.total_cents)}`],
      },
      res
    );
  }

  if (data.type === 'customer') {
    return generateReportPDF(
      {
        title: 'RELATÓRIO POR CLIENTE',
        subtitle: periodLabel,
        store,
        columns: [
          { text: 'Cliente', x: 45, w: 200 },
          { text: 'Abertas', x: 248, w: 45, align: 'right' },
          { text: 'Valor Aberto', x: 296, w: 75, align: 'right' },
          { text: 'Fechadas', x: 374, w: 48, align: 'right' },
          { text: 'Valor Fechado', x: 424, w: 65, align: 'right' },
          { text: 'Total', x: 492, w: 58, align: 'right' },
        ],
        rows: data.items.map((c) => [
          c.customer_name,
          String(c.open_count),
          formatCents(c.open_cents),
          String(c.closed_count),
          formatCents(c.closed_cents),
          formatCents(c.total_cents),
        ]),
        summaryLines: [`Total Geral: ${formatCents(data.total_cents)}`],
      },
      res
    );
  }

  return generateReportPDF(
    {
      title: 'RELATÓRIO POR PERÍODO (RETIRADAS)',
      subtitle: periodLabel,
      store,
      columns: [
        { text: 'Código', x: 45, w: 70 },
        { text: 'Data/Hora', x: 118, w: 80 },
        { text: 'Cliente', x: 200, w: 145 },
        { text: 'Retirado por', x: 348, w: 85 },
        { text: 'Status', x: 435, w: 48, align: 'center' },
        { text: 'Total Líq.', x: 485, w: 65, align: 'right' },
      ],
      rows: data.items.map((w) => [
        w.code,
        formatDateTimeBR(w.withdrawal_date),
        w.customer_name,
        w.picked_up_by,
        w.status.toUpperCase(),
        formatCents(w.net_total_cents),
      ]),
      summaryLines: [`Total Geral: ${formatCents(data.total_cents)}`],
    },
    res
  );
});

router.get('/export/excel', async (req, res) => {
  const data = buildReportData(req.query);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Relatório');

  if (data.type === 'product') {
    sheet.columns = [
      { header: 'Código', key: 'code', width: 15 },
      { header: 'Descrição', key: 'description', width: 40 },
      { header: 'Unidade', key: 'unit', width: 12 },
      { header: 'Quantidade Total', key: 'qty', width: 18 },
      { header: 'Movimentações', key: 'count', width: 15 },
      { header: 'Total (R$)', key: 'total', width: 18 },
    ];
    for (const it of data.items) {
      sheet.addRow({
        code: it.product_code,
        description: it.product_description,
        unit: it.product_unit,
        qty: it.total_qty,
        count: it.withdrawals_count,
        total: it.total_cents / 100,
      });
    }
  } else if (data.type === 'customer') {
    sheet.columns = [
      { header: 'Cliente', key: 'customer', width: 35 },
      { header: 'Retiradas Abertas', key: 'open_count', width: 18 },
      { header: 'Valor Aberto (R$)', key: 'open_val', width: 18 },
      { header: 'Retiradas Fechadas', key: 'closed_count', width: 18 },
      { header: 'Valor Fechado (R$)', key: 'closed_val', width: 18 },
      { header: 'Total (R$)', key: 'total', width: 18 },
    ];
    for (const c of data.items) {
      sheet.addRow({
        customer: c.customer_name,
        open_count: c.open_count,
        open_val: c.open_cents / 100,
        closed_count: c.closed_count,
        closed_val: c.closed_cents / 100,
        total: c.total_cents / 100,
      });
    }
  } else {
    sheet.columns = [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Data/Hora', key: 'date', width: 18 },
      { header: 'Cliente', key: 'customer', width: 32 },
      { header: 'Retirado por', key: 'picked', width: 22 },
      { header: 'Obra/Ref', key: 'work', width: 22 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Total Líquido (R$)', key: 'total', width: 18 },
    ];
    for (const w of data.items) {
      sheet.addRow({
        code: w.code,
        date: formatDateTimeBR(w.withdrawal_date),
        customer: w.customer_name,
        picked: w.picked_up_by,
        work: w.work_reference,
        status: w.status,
        total: w.net_total_cents / 100,
      });
    }
  }

  sheet.getRow(1).font = { bold: true };
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="relatorio_${data.type}_construcenter.xlsx"`
  );
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
