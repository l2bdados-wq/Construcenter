const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/database');
const {
  SESSION_COOKIE,
  createSession,
  getUserFromRequest,
  auditLog,
} = require('../middleware/auth');

const router = express.Router();

router.get('/me', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const user = getUserFromRequest(req);
  const store = db.prepare('SELECT * FROM store_settings WHERE id = 1').get();
  res.json({
    needsSetup: userCount === 0,
    user,
    store,
  });
});

router.post('/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount > 0) {
    return res.status(400).json({ error: 'O administrador inicial já foi configurado.' });
  }

  const { name, username, password } = req.body || {};
  if (!name || !username || !password || String(password).length < 4) {
    return res.status(400).json({
      error: 'Informe nome, usuário e senha com pelo menos 4 caracteres.',
    });
  }

  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare('INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)')
    .run(String(name).trim(), String(username).trim().toLowerCase(), hash, 'admin');

  const user = {
    id: Number(info.lastInsertRowid),
    name: String(name).trim(),
    username: String(username).trim().toLowerCase(),
    role: 'admin',
  };

  const { token, expires } = createSession(user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    expires,
  });

  auditLog({
    user,
    action: 'SETUP_ADMIN',
    entity: 'users',
    entityId: user.id,
    details: { username: user.username },
  });

  res.status(201).json({ user });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }

  const userRow = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username).trim().toLowerCase());

  if (!userRow || !userRow.active) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  const valid = bcrypt.compareSync(String(password), userRow.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  const { token, expires } = createSession(userRow.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    expires,
  });

  const user = {
    id: userRow.id,
    name: userRow.name,
    username: userRow.username,
    role: userRow.role,
  };

  auditLog({
    user,
    action: 'LOGIN',
    entity: 'sessions',
    entityId: user.id,
  });

  res.json({ user });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

module.exports = router;
