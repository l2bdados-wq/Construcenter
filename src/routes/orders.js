const express = require('express');
const { db, runTransaction } = require('../db/database');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');
const { parseCurrencyToCents } = require('../utils/format');
const { enrichWithdrawals } = require('./withdrawals');
const { generateOrderPDF } = require('../services/pdf');

const router = express.Router();
router.use(requireAuth);

function buildConsolidatedItems(withdrawals) {
  const map = new Map();
  for (const w of withdrawals) {
    for (const item of w.items) {
      // Group ONLY when code, unit, and unit_price_cents are identical
      const key = `${item.product_code}::${item.product_unit}::${item.unit_price_cents}`;
      if (!map.has(key)) {
        map.set(key, {
          product_code: item.product_code,
          product_description: item.product_description,
          product_unit: item.product_unit,
          unit_price_cents: item.unit_price_cents,
          quantity: 0,
          subtotal_cents: 0,
        });
      }
      const entry = map.get(key);
      entry.quantity = Math.round((entry.quantity + item.quantity) * 1000) / 1000;
      entry.subtotal_cents += item.subtotal_cents;
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.product_description.localeCompare(b.product_description, 'pt-BR')
  );
}

function getOrderDetails(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
  const wRows = db
    .prepare(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone,
              o.order_number
       FROM withdrawals w
       JOIN order_withdrawals ow ON ow.withdrawal_id = w.id
       JOIN customers c ON c.id = w.customer_id
       JOIN orders o ON o.id = ow.order_id
       WHERE ow.order_id = ?
       ORDER BY w.withdrawal_date ASC, w.id ASC`
    )
    .all(orderId);

  const withdrawals = enrichWithdrawals(wRows);
  const consolidated_items = buildConsolidatedItems(withdrawals);

  return {
    ...order,
    customer,
    withdrawals,
    consolidated_items,
  };
}

router.get('/', (req, res) => {
  const { customer_id, start_date, end_date } = req.query;
  const conditions = [];
  const params = [];

  if (customer_id) {
    conditions.push('o.customer_id = ?');
    params.push(Number(customer_id));
  }
  if (start_date) {
    conditions.push("substr(o.issued_at, 1, 10) >= ?");
    params.push(start_date);
  }
  if (end_date) {
    conditions.push("substr(o.issued_at, 1, 10) <= ?");
    params.push(end_date);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
              (SELECT COUNT(*) FROM order_withdrawals ow WHERE ow.order_id = o.id) AS withdrawals_count
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ${where}
       ORDER BY o.issued_at DESC, o.id DESC`
    )
    .all(...params);

  res.json(rows);
});

router.get('/:id', (req, res) => {
  const data = getOrderDetails(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json(data);
});

router.get('/:id/pdf', (req, res) => {
  const data = getOrderDetails(Number(req.params.id));
  if (!data) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const mode = ['consolidated', 'detailed', 'both'].includes(req.query.mode)
    ? req.query.mode
    : 'consolidated';
  const store = db.prepare('SELECT * FROM store_settings WHERE id = 1').get();
  generateOrderPDF(data, store, mode, res);
});

router.post('/preview', requireRole('admin', 'gerente'), (req, res) => {
  const { customer_id, period_start, period_end, withdrawal_ids, extra_discount } = req.body || {};
  if (!customer_id) {
    return res.status(400).json({ error: 'Selecione um cliente.' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customer_id));
  if (!customer) {
    return res.status(404).json({ error: 'Cliente não encontrado.' });
  }

  const conditions = ["w.customer_id = ?", "w.status = 'aberta'"];
  const params = [customer.id];

  if (period_start) {
    conditions.push("substr(w.withdrawal_date, 1, 10) >= ?");
    params.push(period_start);
  }
  if (period_end) {
    conditions.push("substr(w.withdrawal_date, 1, 10) <= ?");
    params.push(period_end);
  }

  const rows = db
    .prepare(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone
       FROM withdrawals w
       JOIN customers c ON c.id = w.customer_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY w.withdrawal_date ASC, w.id ASC`
    )
    .all(...params);

  const available = enrichWithdrawals(rows);
  const selected =
    Array.isArray(withdrawal_ids) && withdrawal_ids.length > 0
      ? available.filter((w) => withdrawal_ids.map(Number).includes(w.id))
      : available;

  const extraDiscountCents = extra_discount ? parseCurrencyToCents(extra_discount) : 0;
  const subtotal_cents = selected.reduce((acc, w) => acc + w.items_subtotal_cents, 0);
  const returns_cents = selected.reduce((acc, w) => acc + w.returns_total_cents, 0);
  const withdrawals_discount_cents = selected.reduce((acc, w) => acc + (w.discount_cents || 0), 0);
  const discount_cents = withdrawals_discount_cents + (Number.isInteger(extraDiscountCents) ? Math.max(0, extraDiscountCents) : 0);
  const total_cents = Math.max(0, subtotal_cents - returns_cents - discount_cents);

  res.json({
    customer,
    available_withdrawals: available,
    selected_withdrawals: selected,
    consolidated_items: buildConsolidatedItems(selected),
    subtotal_cents,
    returns_cents,
    discount_cents,
    total_cents,
  });
});

router.post('/', requireRole('admin', 'gerente'), (req, res) => {
  const {
    customer_id,
    period_start,
    period_end,
    withdrawal_ids,
    payment_condition = '',
    due_date = '',
    notes = '',
    extra_discount,
    extra_discount_cents,
    idempotency_key,
  } = req.body || {};

  if (idempotency_key) {
    const existing = db
      .prepare('SELECT id FROM orders WHERE idempotency_key = ?')
      .get(String(idempotency_key));
    if (existing) {
      return res.status(200).json(getOrderDetails(existing.id));
    }
  }

  if (!customer_id) {
    return res.status(400).json({ error: 'Cliente é obrigatório.' });
  }
  if (!Array.isArray(withdrawal_ids) || withdrawal_ids.length === 0) {
    return res.status(400).json({ error: 'Selecione pelo menos uma retirada aberta para fechar.' });
  }

  let extraDiscCents = 0;
  if (typeof extra_discount_cents === 'number' && Number.isInteger(extra_discount_cents)) {
    extraDiscCents = extra_discount_cents;
  } else if (extra_discount !== undefined && extra_discount !== null && String(extra_discount).trim() !== '') {
    extraDiscCents = parseCurrencyToCents(extra_discount);
  }
  if (!Number.isInteger(extraDiscCents) || extraDiscCents < 0) {
    return res.status(400).json({ error: 'Desconto adicional inválido.' });
  }

  const uniqueIds = [...new Set(withdrawal_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) {
    return res.status(400).json({ error: 'IDs de retiradas inválidos.' });
  }

  try {
    const orderId = runTransaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customer_id));
      if (!customer) {
        throw Object.assign(new Error('Cliente não encontrado.'), { status: 404 });
      }

      const placeholders = uniqueIds.map(() => '?').join(',');
      const wRows = db
        .prepare(
          `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone
           FROM withdrawals w
           JOIN customers c ON c.id = w.customer_id
           WHERE w.id IN (${placeholders})
           ORDER BY w.withdrawal_date ASC, w.id ASC`
        )
        .all(...uniqueIds);

      if (wRows.length !== uniqueIds.length) {
        throw Object.assign(new Error('Uma ou mais retiradas selecionadas não existem.'), { status: 400 });
      }

      for (const w of wRows) {
        if (w.customer_id !== customer.id) {
          throw Object.assign(
            new Error(`A retirada ${w.code} não pertence ao cliente selecionado.`),
            { status: 400 }
          );
        }
        if (w.status !== 'aberta') {
          throw Object.assign(
            new Error(`A retirada ${w.code} já está "${w.status}" e não pode ser incluída novamente.`),
            { status: 409 }
          );
        }
        const alreadyLinked = db
          .prepare('SELECT order_id FROM order_withdrawals WHERE withdrawal_id = ?')
          .get(w.id);
        if (alreadyLinked) {
          throw Object.assign(
            new Error(`A retirada ${w.code} já está vinculada a outro pedido.`),
            { status: 409 }
          );
        }
      }

      const enriched = enrichWithdrawals(wRows);
      const subtotal_cents = enriched.reduce((acc, w) => acc + w.items_subtotal_cents, 0);
      const returns_cents = enriched.reduce((acc, w) => acc + w.returns_total_cents, 0);
      const withdrawals_discount_cents = enriched.reduce((acc, w) => acc + (w.discount_cents || 0), 0);
      const discount_cents = withdrawals_discount_cents + extraDiscCents;
      const total_cents = Math.max(0, subtotal_cents - returns_cents - discount_cents);

      const year = String(new Date().getFullYear());
      const countRow = db
        .prepare('SELECT COUNT(*) AS cnt FROM orders WHERE order_number LIKE ?')
        .get(`PED-${year}-%`);
      let seq = (countRow?.cnt || 0) + 1;
      let orderNumber = `PED-${year}-${String(seq).padStart(4, '0')}`;
      while (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(orderNumber)) {
        seq += 1;
        orderNumber = `PED-${year}-${String(seq).padStart(4, '0')}`;
      }

      const pStart = period_start || enriched[0].withdrawal_date.slice(0, 10);
      const pEnd = period_end || enriched[enriched.length - 1].withdrawal_date.slice(0, 10);

      const orderInfo = db
        .prepare(
          `INSERT INTO orders (
            order_number, customer_id, period_start, period_end, payment_condition, due_date,
            notes, subtotal_cents, discount_cents, returns_cents, total_cents, created_by, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          orderNumber,
          customer.id,
          pStart,
          pEnd,
          String(payment_condition || '').trim(),
          String(due_date || '').trim(),
          String(notes || '').trim(),
          subtotal_cents,
          discount_cents,
          returns_cents,
          total_cents,
          req.user.id,
          idempotency_key ? String(idempotency_key) : null
        );

      const newOrderId = Number(orderInfo.lastInsertRowid);
      const linkStmt = db.prepare(
        'INSERT INTO order_withdrawals (order_id, withdrawal_id) VALUES (?, ?)'
      );
      const closeStmt = db.prepare(
        "UPDATE withdrawals SET status = 'fechada', order_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND status = 'aberta'"
      );

      for (const w of enriched) {
        const upd = closeStmt.run(newOrderId, w.id);
        if (upd.changes !== 1) {
          throw Object.assign(
            new Error(`Conflito transacional: retirada ${w.code} já foi fechada simultaneamente.`),
            { status: 409 }
          );
        }
        linkStmt.run(newOrderId, w.id);
      }

      auditLog({
        user: req.user,
        action: 'CREATE_ORDER',
        entity: 'orders',
        entityId: newOrderId,
        details: {
          order_number: orderNumber,
          customer: customer.name,
          withdrawal_codes: enriched.map((w) => w.code),
          total_cents,
        },
      });

      return newOrderId;
    });

    res.status(201).json(getOrderDetails(orderId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
