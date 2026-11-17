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

router.get('/me', async (req, res, next) => {
  try {
    const countRow = await db.get('SELECT COUNT(*) AS count FROM users');
    const user = await getUserFromRequest(req);
    const store = await db.get('SELECT * FROM store_settings WHERE id = 1');
    res.json({
      needsSetup: (countRow?.count || 0) === 0,
      user,
      store,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/setup', async (req, res, next) => {
  try {
    const countRow = await db.get('SELECT COUNT(*) AS count FROM users');
    if ((countRow?.count || 0) > 0) {
      return res.status(400).json({ error: 'O administrador inicial já foi configurado.' });
    }

    const { name, username, password } = req.body || {};
    if (!name || !username || !password || String(password).length < 4) {
      return res.status(400).json({
        error: 'Informe nome, usuário e senha com pelo menos 4 caracteres.',
      });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const info = await db.run(
      'INSERT INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)',
      String(name).trim(),
      String(username).trim().toLowerCase(),
      hash,
      'admin'
    );

    const user = {
      id: info.lastInsertRowid,
      name: String(name).trim(),
      username: String(username).trim().toLowerCase(),
      role: 'admin',
    };

    const { token, expires } = await createSession(user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      expires,
    });

    await auditLog({
      user,
      action: 'SETUP_ADMIN',
      entity: 'users',
      entityId: user.id,
      details: { username: user.username },
    });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Informe usuário e senha.' });
    }

    const userRow = await db.get(
      'SELECT * FROM users WHERE username = ?',
      String(username).trim().toLowerCase()
    );

    if (!userRow || !userRow.active) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    const valid = bcrypt.compareSync(String(password), userRow.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    const { token, expires } = await createSession(userRow.id);
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

    await auditLog({
      user,
      action: 'LOGIN',
      entity: 'sessions',
      entityId: user.id,
    });

    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await db.run('DELETE FROM sessions WHERE token = ?', token);
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
