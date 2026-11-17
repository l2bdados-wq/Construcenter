const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const fs = require('node:fs');
const { db, getTenantPaths, getCurrentTenantSlug } = require('../db/database');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');
const { createBackup, listBackups } = require('../services/backup');

const router = express.Router();
router.use(requireAuth);

router.get('/users', requireRole('admin'), (req, res) => {
  const users = db
    .prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name ASC')
    .all();
  res.json(users);
});

router.post('/users', requireRole('admin'), (req, res) => {
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
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (exists) {
    return res.status(409).json({ error: `Usuário "${uname}" já existe.` });
  }

  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare('INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)')
    .run(String(name).trim(), uname, hash, role);

  auditLog({
    user: req.user,
    action: 'CREATE_USER',
    entity: 'users',
    entityId: info.lastInsertRowid,
    details: { username: uname, role },
  });

  const created = db
    .prepare('SELECT id, name, username, role, active, created_at FROM users WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  res.status(201).json(created);
});

router.put('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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
    db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').run(
      newName,
      newRole,
      newActive,
      hash,
      id
    );
  } else {
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(
      newName,
      newRole,
      newActive,
      id
    );
  }

  auditLog({
    user: req.user,
    action: 'UPDATE_USER',
    entity: 'users',
    entityId: id,
    details: { username: existing.username, role: newRole, active: newActive },
  });

  const updated = db
    .prepare('SELECT id, name, username, role, active, created_at FROM users WHERE id = ?')
    .get(id);
  res.json(updated);
});

router.get('/settings', (req, res) => {
  const store = db.prepare('SELECT * FROM store_settings WHERE id = 1').get();
  res.json(store);
});

router.put('/settings', requireRole('admin'), (req, res) => {
  const { name, subtitle, cnpj, phone, address, footer_note } = req.body || {};
  db.prepare(
    `UPDATE store_settings
     SET name = ?, subtitle = ?, cnpj = ?, phone = ?, address = ?, footer_note = ?
     WHERE id = 1`
  ).run(
    String(name || 'CONSTRUCENTER').trim(),
    String(subtitle || '').trim(),
    String(cnpj || '').trim(),
    String(phone || '').trim(),
    String(address || '').trim(),
    String(footer_note || 'Pedido — sem valor fiscal').trim()
  );

  auditLog({
    user: req.user,
    action: 'UPDATE_SETTINGS',
    entity: 'store_settings',
    entityId: 1,
  });

  res.json(db.prepare('SELECT * FROM store_settings WHERE id = 1').get());
});

router.get('/audit-logs', requireRole('admin', 'gerente'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json(logs);
});

router.get('/backups', requireRole('admin'), (req, res) => {
  res.json(listBackups());
});

router.post('/backups', requireRole('admin'), (req, res) => {
  const info = createBackup('manual');
  auditLog({
    user: req.user,
    action: 'CREATE_BACKUP',
    entity: 'backups',
    details: { filename: info.filename },
  });
  res.status(201).json(info);
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
