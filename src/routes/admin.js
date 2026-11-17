const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const fs = require('node:fs');
const { db, getTenantPaths, getCurrentTenantSlug } = require('../db/database');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');
const { createBackup, listBackups } = require('../services/backup');

const router = express.Router();
router.use(requireAuth);

router.get('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const users = await db.all(
      'SELECT id, name, username, role, active, created_at FROM users ORDER BY name ASC'
    );
    res.json(users);
  } catch (err) {
    next(err);
  }
});

router.post('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, username, password, role = 'atendente' } = req.body || {};
    if (!name || !username || !password || String(password).length < 4) {
      return res.status(400).json({
        error: 'Informe nome, usuário e senha com pelo menos 4 caracteres.',
      });
    }
    if (!['admin', 'gerente', 'atendente'].includes(role)) {
      return res.status(400).json({ error: 'Perfil inválido.' });
    }

    const uname = String(username).trim().toLowerCase();
    const exists = await db.get('SELECT id FROM users WHERE username = ?', uname);
    if (exists) {
      return res.status(409).json({ error: `Usuário "${uname}" já existe.` });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const info = await db.run(
      'INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)',
      String(name).trim(),
      uname,
      hash,
      role
    );

    await auditLog({
      user: req.user,
      action: 'CREATE_USER',
      entity: 'users',
      entityId: info.lastInsertRowid,
      details: { username: uname, role },
    });

    const created = await db.get(
      'SELECT id, name, username, role, active, created_at FROM users WHERE id = ?',
      info.lastInsertRowid
    );
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const { name, role, active, password } = req.body || {};
    const newRole = ['admin', 'gerente', 'atendente'].includes(role) ? role : existing.role;
    const newActive = active !== undefined ? (active ? 1 : 0) : existing.active;
    const newName = name ? String(name).trim() : existing.name;

    if (password && String(password).trim()) {
      if (String(password).length < 4) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres.' });
      }
      const hash = bcrypt.hashSync(String(password), 10);
      await db.run(
        'UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?',
        newName,
        newRole,
        newActive,
        hash,
        id
      );
    } else {
      await db.run(
        'UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?',
        newName,
        newRole,
        newActive,
        id
      );
    }

    await auditLog({
      user: req.user,
      action: 'UPDATE_USER',
      entity: 'users',
      entityId: id,
      details: { username: existing.username, role: newRole, active: newActive },
    });

    const updated = await db.get(
      'SELECT id, name, username, role, active, created_at FROM users WHERE id = ?',
      id
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const store = await db.get('SELECT * FROM store_settings WHERE id = 1');
    res.json(store);
  } catch (err) {
    next(err);
  }
});

router.put('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, subtitle, cnpj, phone, address, footer_note } = req.body || {};
    await db.run(
      `UPDATE store_settings
       SET name = ?, subtitle = ?, cnpj = ?, phone = ?, address = ?, footer_note = ?
       WHERE id = 1`,
      String(name || 'CONSTRUCENTER').trim(),
      String(subtitle || '').trim(),
      String(cnpj || '').trim(),
      String(phone || '').trim(),
      String(address || '').trim(),
      String(footer_note || 'Pedido — sem valor fiscal').trim()
    );

    await auditLog({
      user: req.user,
      action: 'UPDATE_SETTINGS',
      entity: 'store_settings',
      entityId: 1,
    });

    res.json(await db.get('SELECT * FROM store_settings WHERE id = 1'));
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs', requireRole('admin', 'gerente'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = await db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', limit);
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

router.get('/backups', requireRole('admin'), (req, res) => {
  res.json(listBackups());
});

router.post('/backups', requireRole('admin'), async (req, res, next) => {
  try {
    const info = await createBackup('manual');
    await auditLog({
      user: req.user,
      action: 'CREATE_BACKUP',
      entity: 'backups',
      details: { filename: info.filename },
    });
    res.status(201).json(info);
  } catch (err) {
    next(err);
  }
});

router.get('/backups/:filename', requireRole('admin'), (req, res) => {
  const safeName = path.basename(req.params.filename);
  const { backupDir } = getTenantPaths(getCurrentTenantSlug());
  const full = path.join(backupDir, safeName);
  if (!safeName.endsWith('.db') || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'Backup não encontrado.' });
  }
  res.download(full, safeName);
});

module.exports = router;
