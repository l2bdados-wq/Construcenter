const crypto = require('node:crypto');
const { db } = require('../db/database');

const SESSION_COOKIE = 'cc_session';
const SESSION_DAYS = 7;

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const expiresAt = expires.toISOString().replace('T', ' ').slice(0, 19);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expiresAt);
  return { token, expires };
}

async function getUserFromRequest(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  const row = await db.get(
    `SELECT u.id, u.name, u.username, u.role, u.active, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    token
  );

  if (!row) return null;
  if (!row.active) return null;

  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (row.expires_at < nowIso) {
    await db.run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
  };
}

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Acesso negado. Permissão necessária: ${roles.join(' ou ')}.`,
      });
    }
    next();
  };
}

async function auditLog({ user, action, entity, entityId = '', reason = '', details = '' }) {
  const detailsStr = typeof details === 'string' ? details : JSON.stringify(details);
  await db.run(
    `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, reason, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    user?.id || null,
    user?.name || 'Sistema',
    action,
    entity,
    String(entityId || ''),
    reason || '',
    detailsStr
  );
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  getUserFromRequest,
  requireAuth,
  requireRole,
  auditLog,
};
