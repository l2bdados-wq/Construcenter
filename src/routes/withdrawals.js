const express = require('express');
const { db, runTransaction } = require('../db/database');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');
const {
  parseCurrencyToCents,
  parseQuantity,
  computeSubtotalCents,
  nowLocalISO,
} = require('../utils/format');
const { generateWithdrawalReceiptPDF } = require('../services/pdf');

const router = express.Router();
router.use(requireAuth);

async function enrichWithdrawals(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const [items, returns, corrections] = await Promise.all([
    db.all(`SELECT * FROM withdrawal_items WHERE withdrawal_id IN (${placeholders}) ORDER BY id ASC`, ...ids),
    db.all(
      `SELECT wr.*, wi.product_code, wi.product_description, wi.product_unit
       FROM withdrawal_returns wr
       JOIN withdrawal_items wi ON wi.id = wr.withdrawal_item_id
       WHERE wr.withdrawal_id IN (${placeholders})
       ORDER BY wr.id ASC`,
      ...ids
    ),
    db.all(
      `SELECT * FROM withdrawal_corrections WHERE withdrawal_id IN (${placeholders}) ORDER BY id DESC`,
      ...ids
    ),
  ]);

  const itemsByW = new Map();
  for (const it of items) {
    if (!itemsByW.has(it.withdrawal_id)) itemsByW.set(it.withdrawal_id, []);
    itemsByW.get(it.withdrawal_id).push(it);
  }

  const returnsByW = new Map();
  const returnedQtyByItem = new Map();
  for (const ret of returns) {
    if (!returnsByW.has(ret.withdrawal_id)) returnsByW.set(ret.withdrawal_id, []);
    returnsByW.get(ret.withdrawal_id).push(ret);
    returnedQtyByItem.set(
      ret.withdrawal_item_id,
      Math.round(((returnedQtyByItem.get(ret.withdrawal_item_id) || 0) + ret.quantity) * 1000) / 1000
    );
  }

  const corrByW = new Map();
  for (const c of corrections) {
    if (!corrByW.has(c.withdrawal_id)) corrByW.set(c.withdrawal_id, []);
    corrByW.get(c.withdrawal_id).push(c);
  }

  return rows.map((w) => {
    const wItems = (itemsByW.get(w.id) || []).map((it) => {
      const returned_qty = returnedQtyByItem.get(it.id) || 0;
      const remaining_qty = Math.max(0, Math.round((it.quantity - returned_qty) * 1000) / 1000);
      return { ...it, returned_qty, remaining_qty };
    });
    const wReturns = returnsByW.get(w.id) || [];
    const items_subtotal_cents = wItems.reduce((acc, it) => acc + it.subtotal_cents, 0);
    const returns_total_cents = wReturns.reduce((acc, r) => acc + r.refund_cents, 0);
    const net_total_cents =
      w.status === 'cancelada'
        ? 0
        : Math.max(0, items_subtotal_cents - returns_total_cents - (w.discount_cents || 0));

    return {
      ...w,
      items: wItems,
      returns: wReturns,
      corrections: corrByW.get(w.id) || [],
      items_subtotal_cents,
      returns_total_cents,
      net_total_cents,
    };
  });
}

async function getWithdrawalById(id) {
  const row = await db.get(
    `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone,
            o.order_number
     FROM withdrawals w
     JOIN customers c ON c.id = w.customer_id
     LEFT JOIN orders o ON o.id = w.order_id
     WHERE w.id = ?`,
    id
  );
  if (!row) return null;
  const enriched = await enrichWithdrawals([row]);
  return enriched[0];
}

router.get('/', async (req, res, next) => {
  try {
    const { customer_id, status, start_date, end_date, work_reference, q } = req.query;
    const conditions = [];
    const params = [];

    if (customer_id) {
      conditions.push('w.customer_id = ?');
      params.push(Number(customer_id));
    }
    if (status && ['aberta', 'fechada', 'cancelada'].includes(status)) {
      conditions.push('w.status = ?');
      params.push(status);
    }
    if (start_date) {
      conditions.push("substr(w.withdrawal_date, 1, 10) >= ?");
      params.push(start_date);
    }
    if (end_date) {
      conditions.push("substr(w.withdrawal_date, 1, 10) <= ?");
      params.push(end_date);
    }
    if (work_reference && work_reference.trim()) {
      conditions.push('w.work_reference LIKE ?');
      params.push(`%${work_reference.trim()}%`);
    }
    if (q && q.trim()) {
      conditions.push('(w.code LIKE ? OR c.name LIKE ? OR w.picked_up_by LIKE ? OR w.work_reference LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT w.*, c.name AS customer_name, c.document AS customer_document, c.phone AS customer_phone,
              o.order_number
       FROM withdrawals w
       JOIN customers c ON c.id = w.customer_id
       LEFT JOIN orders o ON o.id = w.order_id
       ${where}
       ORDER BY w.withdrawal_date DESC, w.id DESC`,
      ...params
    );

    const enriched = await enrichWithdrawals(rows);
    const open_total_cents = enriched
      .filter((w) => w.status === 'aberta')
      .reduce((acc, w) => acc + w.net_total_cents, 0);

    res.json({
      withdrawals: enriched,
      summary: {
        count: enriched.length,
        open_count: enriched.filter((w) => w.status === 'aberta').length,
        open_total_cents,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const w = await getWithdrawalById(Number(req.params.id));
    if (!w) {
      return res.status(404).json({ error: 'Retirada não encontrada.' });
    }
    res.json(w);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/pdf', async (req, res, next) => {
  try {
    const w = await getWithdrawalById(Number(req.params.id));
    if (!w) {
      return res.status(404).json({ error: 'Retirada não encontrada.' });
    }
    const store = await db.get('SELECT * FROM store_settings WHERE id = 1');
    generateWithdrawalReceiptPDF(w, store, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      customer_id,
      withdrawal_date,
      picked_up_by,
      authorized_person_id = null,
      work_reference = '',
      discount,
      discount_cents,
      notes = '',
      items,
      idempotency_key,
    } = req.body || {};

    if (idempotency_key) {
      const existing = await db.get(
        'SELECT id FROM withdrawals WHERE idempotency_key = ?',
        String(idempotency_key)
      );
      if (existing) {
        return res.status(200).json(await getWithdrawalById(existing.id));
      }
    }

    const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(customer_id));
    if (!customer) {
      return res.status(400).json({ error: 'Cliente inválido ou não encontrado.' });
    }
    if (customer.status !== 'ativo') {
      return res.status(400).json({ error: 'Cliente inativo não pode realizar novas retiradas.' });
    }

    if (!picked_up_by || !String(picked_up_by).trim()) {
      return res.status(400).json({ error: 'Informe quem retirou os produtos.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Adicione pelo menos um produto à retirada.' });
    }

    let discCents = 0;
    if (typeof discount_cents === 'number' && Number.isInteger(discount_cents)) {
      discCents = discount_cents;
    } else if (discount !== undefined && discount !== null && String(discount).trim() !== '') {
      discCents = parseCurrencyToCents(discount);
    }
    if (!Number.isInteger(discCents) || discCents < 0) {
      return res.status(400).json({ error: 'Desconto inválido.' });
    }

    if (discCents > 0 && !['admin', 'gerente'].includes(req.user.role)) {
      return res.status(403).json({
        error: 'Apenas Gerente ou Administrador podem conceder descontos.',
      });
    }

    const parsedItems = [];
    for (const item of items) {
      const prod = await db.get('SELECT * FROM products WHERE id = ?', Number(item.product_id));
      if (!prod) {
        return res.status(400).json({ error: `Produto ID ${item.product_id} não encontrado.` });
      }
      if (prod.status !== 'ativo') {
        return res.status(400).json({ error: `Produto "${prod.description}" está inativo.` });
      }

      const qty = parseQuantity(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: `Quantidade inválida para "${prod.description}".` });
      }

      let unitPriceCents = prod.price_cents;
      if (typeof item.unit_price_cents === 'number' && Number.isInteger(item.unit_price_cents) && item.unit_price_cents >= 0) {
        unitPriceCents = item.unit_price_cents;
      } else if (item.unit_price !== undefined && item.unit_price !== null && String(item.unit_price).trim() !== '') {
        const parsedPrice = parseCurrencyToCents(item.unit_price);
        if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
          return res.status(400).json({ error: `Preço unitário inválido para "${prod.description}".` });
        }
        unitPriceCents = parsedPrice;
      }

      parsedItems.push({
        product_id: prod.id,
        product_code: prod.internal_code,
        product_description: prod.description,
        product_unit: prod.unit,
        quantity: qty,
        unit_price_cents: unitPriceCents,
        subtotal_cents: computeSubtotalCents(qty, unitPriceCents),
      });
    }

    const dateStr = withdrawal_date
      ? String(withdrawal_date).replace('T', ' ').slice(0, 19)
      : nowLocalISO();

    const withdrawalId = await runTransaction(async () => {
      const year = dateStr.slice(0, 4) || String(new Date().getFullYear());
      const countRow = await db.get(
        'SELECT COUNT(*) AS cnt FROM withdrawals WHERE code LIKE ?',
        `RET-${year}-%`
      );
      const seq = (countRow?.cnt || 0) + 1;
      let code = `RET-${year}-${String(seq).padStart(4, '0')}`;
      while (await db.get('SELECT id FROM withdrawals WHERE code = ?', code)) {
        code = `RET-${year}-${String(seq + Math.floor(Math.random() * 1000)).padStart(4, '0')}`;
      }

      const info = await db.run(
        `INSERT INTO withdrawals (
          code, customer_id, withdrawal_date, picked_up_by, authorized_person_id,
          employee_id, employee_name, work_reference, discount_cents, notes, status, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?)`,
        code,
        customer.id,
        dateStr,
        String(picked_up_by).trim(),
        authorized_person_id ? Number(authorized_person_id) : null,
        req.user.id,
        req.user.name,
        String(work_reference || '').trim(),
        discCents,
        String(notes || '').trim(),
        idempotency_key ? String(idempotency_key) : null
      );

      const wId = info.lastInsertRowid;
      for (const pi of parsedItems) {
        await db.run(
          `INSERT INTO withdrawal_items (
            withdrawal_id, product_id, product_code, product_description, product_unit,
            quantity, unit_price_cents, subtotal_cents
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          wId,
          pi.product_id,
          pi.product_code,
          pi.product_description,
          pi.product_unit,
          pi.quantity,
          pi.unit_price_cents,
          pi.subtotal_cents
        );
      }

      await auditLog({
        user: req.user,
        action: 'CREATE',
        entity: 'withdrawals',
        entityId: wId,
        details: { code, customer: customer.name, items_count: parsedItems.length },
      });

      return wId;
    });

    res.status(201).json(await getWithdrawalById(withdrawalId));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/returns', async (req, res) => {
  const withdrawalId = Number(req.params.id);
  const { withdrawal_item_id, quantity, reason } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'Informe o motivo da devolução.' });
  }

  const qty = parseQuantity(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantidade de devolução inválida.' });
  }

  try {
    const updated = await runTransaction(async () => {
      const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', withdrawalId);
      if (!w) throw Object.assign(new Error('Retirada não encontrada.'), { status: 404 });
      if (w.status !== 'aberta') {
        throw Object.assign(
          new Error('Devoluções diretas só podem ser registradas em retiradas abertas.'),
          { status: 400 }
        );
      }

      const item = await db.get(
        'SELECT * FROM withdrawal_items WHERE id = ? AND withdrawal_id = ?',
        Number(withdrawal_item_id),
        withdrawalId
      );
      if (!item) {
        throw Object.assign(new Error('Item da retirada não encontrado.'), { status: 404 });
      }

      const retRow = await db.get(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM withdrawal_returns WHERE withdrawal_item_id = ?',
        item.id
      );
      const returnedSum = retRow?.total || 0;

      const available = Math.round((item.quantity - returnedSum) * 1000) / 1000;
      if (qty > available + 0.0001) {
        throw Object.assign(
          new Error(
            `Quantidade devolvida (${qty}) excede o saldo disponível (${available}) do item.`
          ),
          { status: 400 }
        );
      }

      const refundCents = computeSubtotalCents(qty, item.unit_price_cents);
      await db.run(
        `INSERT INTO withdrawal_returns (withdrawal_id, withdrawal_item_id, quantity, refund_cents, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        withdrawalId,
        item.id,
        qty,
        refundCents,
        String(reason).trim(),
        req.user.id
      );

      await auditLog({
        user: req.user,
        action: 'RETURN_ITEM',
        entity: 'withdrawals',
        entityId: withdrawalId,
        reason: String(reason).trim(),
        details: { item_id: item.id, product: item.product_description, quantity: qty, refund_cents: refundCents },
      });

      return await getWithdrawalById(withdrawalId);
    });

    res.status(201).json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/cancel', requireRole('admin', 'gerente'), async (req, res, next) => {
  try {
    const withdrawalId = Number(req.params.id);
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Informe o motivo do cancelamento.' });
    }

    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', withdrawalId);
    if (!w) return res.status(404).json({ error: 'Retirada não encontrada.' });
    if (w.status !== 'aberta') {
      return res.status(400).json({ error: 'Apenas retiradas abertas podem ser canceladas.' });
    }

    await db.run(
      "UPDATE withdrawals SET status = 'cancelada', updated_at = datetime('now', 'localtime') WHERE id = ?",
      withdrawalId
    );

    await auditLog({
      user: req.user,
      action: 'CANCEL',
      entity: 'withdrawals',
      entityId: withdrawalId,
      reason: String(reason).trim(),
      details: { code: w.code },
    });

    res.json(await getWithdrawalById(withdrawalId));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const withdrawalId = Number(req.params.id);
    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', withdrawalId);
    if (!w) return res.status(404).json({ error: 'Retirada não encontrada.' });

    if (w.status === 'fechada') {
      return res.status(403).json({
        error: 'Edição direta bloqueada: retirada já fechada. Utilize a função de Correção Pós-Fechamento.',
      });
    }
    if (w.status === 'cancelada') {
      return res.status(400).json({ error: 'Retirada cancelada não pode ser editada.' });
    }

    const { picked_up_by, work_reference, notes, discount, discount_cents } = req.body || {};
    let discCents = w.discount_cents;
    if (typeof discount_cents === 'number' && Number.isInteger(discount_cents)) {
      discCents = discount_cents;
    } else if (discount !== undefined) {
      discCents = parseCurrencyToCents(discount);
    }
    if (!Number.isInteger(discCents) || discCents < 0) {
      return res.status(400).json({ error: 'Desconto inválido.' });
    }
    if (discCents !== w.discount_cents && !['admin', 'gerente'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas Gerente ou Administrador podem alterar descontos.' });
    }

    await db.run(
      `UPDATE withdrawals
       SET picked_up_by = ?, work_reference = ?, notes = ?, discount_cents = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      picked_up_by ? String(picked_up_by).trim() : w.picked_up_by,
      work_reference !== undefined ? String(work_reference).trim() : w.work_reference,
      notes !== undefined ? String(notes).trim() : w.notes,
      discCents,
      withdrawalId
    );

    await auditLog({
      user: req.user,
      action: 'UPDATE',
      entity: 'withdrawals',
      entityId: withdrawalId,
      details: { code: w.code },
    });

    res.json(await getWithdrawalById(withdrawalId));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/correct', requireRole('admin', 'gerente'), async (req, res) => {
  const withdrawalId = Number(req.params.id);
  const { reason, picked_up_by, work_reference, notes, discount, discount_cents } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'O motivo da correção é obrigatório.' });
  }

  try {
    const result = await runTransaction(async () => {
      const before = await getWithdrawalById(withdrawalId);
      if (!before) throw Object.assign(new Error('Retirada não encontrada.'), { status: 404 });

      let discCents = before.discount_cents;
      if (typeof discount_cents === 'number' && Number.isInteger(discount_cents)) {
        discCents = discount_cents;
      } else if (discount !== undefined && discount !== null && String(discount).trim() !== '') {
        discCents = parseCurrencyToCents(discount);
      }
      if (!Number.isInteger(discCents) || discCents < 0) {
        throw Object.assign(new Error('Desconto inválido.'), { status: 400 });
      }

      await db.run(
        `UPDATE withdrawals
         SET picked_up_by = ?, work_reference = ?, notes = ?, discount_cents = ?, updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        picked_up_by ? String(picked_up_by).trim() : before.picked_up_by,
        work_reference !== undefined ? String(work_reference).trim() : before.work_reference,
        notes !== undefined ? String(notes).trim() : before.notes,
        discCents,
        withdrawalId
      );

      if (before.order_id) {
        const linkedWithdrawals = await db.all(
          'SELECT id, discount_cents FROM withdrawals WHERE order_id = ?',
          before.order_id
        );
        const totalDiscount = linkedWithdrawals.reduce((acc, lw) => acc + (lw.discount_cents || 0), 0);
        const orderRow = await db.get('SELECT * FROM orders WHERE id = ?', before.order_id);
        if (orderRow) {
          const newTotal = Math.max(0, orderRow.subtotal_cents - orderRow.returns_cents - totalDiscount);
          await db.run(
            'UPDATE orders SET discount_cents = ?, total_cents = ? WHERE id = ?',
            totalDiscount,
            newTotal,
            orderRow.id
          );
        }
      }

      const after = await getWithdrawalById(withdrawalId);
      await db.run(
        `INSERT INTO withdrawal_corrections (withdrawal_id, user_id, user_name, reason, previous_snapshot, new_snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
        withdrawalId,
        req.user.id,
        req.user.name,
        String(reason).trim(),
        JSON.stringify(before),
        JSON.stringify(after)
      );

      await auditLog({
        user: req.user,
        action: 'POST_CLOSE_CORRECTION',
        entity: 'withdrawals',
        entityId: withdrawalId,
        reason: String(reason).trim(),
        details: { code: before.code, before_discount: before.discount_cents, after_discount: discCents },
      });

      return await getWithdrawalById(withdrawalId);
    });

    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = {
  router,
  enrichWithdrawals,
  getWithdrawalById,
};
