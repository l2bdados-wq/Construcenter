const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@libsql/client');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || 'construcenter').toLowerCase();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });

const tenantStorage = new AsyncLocalStorage();
const txStorage = new AsyncLocalStorage();
const adapterCache = new Map();
const schemaInitialized = new Set();

// Master database for tenant registry
const MASTER_DB_PATH = path.join(DATA_DIR, 'master.db');
const masterDb = new DatabaseSync(MASTER_DB_PATH);
masterDb.exec('PRAGMA journal_mode = WAL;');
masterDb.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    turso_url TEXT DEFAULT '',
    turso_token TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// Ensure columns exist if upgrading from earlier master.db
try {
  masterDb.exec("ALTER TABLE tenants ADD COLUMN turso_url TEXT DEFAULT ''");
} catch (_) {}
try {
  masterDb.exec("ALTER TABLE tenants ADD COLUMN turso_token TEXT DEFAULT ''");
} catch (_) {}

masterDb
  .prepare('INSERT OR IGNORE INTO tenants (slug, name, active) VALUES (?, ?, 1)')
  .run('construcenter', 'CONSTRUCENTER');

function buildSchemaSQL(storeName = 'CONSTRUCENTER') {
  const safeName = String(storeName || 'CONSTRUCENTER').replace(/'/g, "''");
  return `
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'CONSTRUCENTER',
      subtitle TEXT NOT NULL DEFAULT 'Materiais para Construção e Elétrica em Geral',
      cnpj TEXT DEFAULT '',
      phone TEXT NOT NULL DEFAULT '(77) 9.9963-2028',
      address TEXT DEFAULT '',
      footer_note TEXT DEFAULT 'Pedido — sem valor fiscal'
    );

    INSERT OR IGNORE INTO store_settings (id, name) VALUES (1, '${safeName}');

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'gerente', 'atendente')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      document TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS customer_authorized_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      identification TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_code TEXT NOT NULL UNIQUE,
      barcode TEXT DEFAULT '',
      description TEXT NOT NULL,
      brand TEXT DEFAULT '',
      category TEXT DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'unidade',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_desc ON products(description);

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      payment_condition TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      returns_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      idempotency_key TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      withdrawal_date TEXT NOT NULL,
      picked_up_by TEXT NOT NULL,
      authorized_person_id INTEGER REFERENCES customer_authorized_people(id),
      employee_id INTEGER NOT NULL REFERENCES users(id),
      employee_name TEXT NOT NULL,
      work_reference TEXT DEFAULT '',
      discount_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada', 'cancelada')),
      order_id INTEGER REFERENCES orders(id),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_withdrawals_customer_status ON withdrawals(customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_date ON withdrawals(withdrawal_date);

    CREATE TABLE IF NOT EXISTS withdrawal_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_code TEXT NOT NULL,
      product_description TEXT NOT NULL,
      product_unit TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0)
    );

    CREATE TABLE IF NOT EXISTS withdrawal_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id),
      withdrawal_item_id INTEGER NOT NULL REFERENCES withdrawal_items(id),
      quantity REAL NOT NULL CHECK (quantity > 0),
      refund_cents INTEGER NOT NULL CHECK (refund_cents >= 0),
      reason TEXT NOT NULL,
      returned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      created_by INTEGER NOT NULL REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_withdrawals (
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      withdrawal_id INTEGER NOT NULL UNIQUE REFERENCES withdrawals(id),
      PRIMARY KEY (order_id, withdrawal_id)
    );

    CREATE TABLE IF NOT EXISTS withdrawal_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      user_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      previous_snapshot TEXT NOT NULL,
      new_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `;
}

function getTenantPaths(slug = DEFAULT_TENANT) {
  const safeSlug = String(slug || DEFAULT_TENANT).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (process.env.DB_PATH && safeSlug === DEFAULT_TENANT) {
    const dbDir = path.dirname(process.env.DB_PATH);
    return {
      slug: safeSlug,
      dir: dbDir,
      dbPath: process.env.DB_PATH,
      backupDir: process.env.BACKUP_DIR || path.join(dbDir, 'backups'),
      logoPath: path.join(__dirname, '..', '..', 'logo.jpeg'),
    };
  }

  const legacyDb = path.join(DATA_DIR, 'construcenter.db');
  const tenantDir = path.join(TENANTS_DIR, safeSlug);
  const tenantDb = path.join(tenantDir, 'store.db');

  if (safeSlug === 'construcenter' && fs.existsSync(legacyDb) && !fs.existsSync(tenantDb)) {
    return {
      slug: safeSlug,
      dir: DATA_DIR,
      dbPath: legacyDb,
      backupDir: path.join(DATA_DIR, 'backups'),
      logoPath: path.join(__dirname, '..', '..', 'logo.jpeg'),
    };
  }

  if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
  const tenantLogo = path.join(tenantDir, 'logo.jpeg');
  return {
    slug: safeSlug,
    dir: tenantDir,
    dbPath: tenantDb,
    backupDir: path.join(tenantDir, 'backups'),
    logoPath: fs.existsSync(tenantLogo) ? tenantLogo : path.join(__dirname, '..', '..', 'logo.jpeg'),
  };
}

function getTursoConfig(slug) {
  const tenantRow = masterDb.prepare('SELECT turso_url, turso_token FROM tenants WHERE slug = ?').get(slug);
  if (tenantRow?.turso_url) {
    return { url: tenantRow.turso_url, authToken: tenantRow.turso_token };
  }
  if (slug === DEFAULT_TENANT && process.env.TURSO_DATABASE_URL) {
    return {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || '',
    };
  }
  return null;
}

function createLocalAdapter(dbPath, storeName) {
  const nativeDb = new DatabaseSync(dbPath);
  nativeDb.exec('PRAGMA journal_mode = WAL;');
  nativeDb.exec('PRAGMA foreign_keys = ON;');
  nativeDb.exec('PRAGMA busy_timeout = 5000;');
  nativeDb.exec(buildSchemaSQL(storeName));

  return {
    isTurso: false,
    nativeDb,
    async get(sql, ...params) {
      return nativeDb.prepare(sql).get(...params);
    },
    async all(sql, ...params) {
      return nativeDb.prepare(sql).all(...params);
    },
    async run(sql, ...params) {
      const info = nativeDb.prepare(sql).run(...params);
      return {
        lastInsertRowid: Number(info.lastInsertRowid || 0),
        changes: Number(info.changes || 0),
      };
    },
    async exec(sql) {
      nativeDb.exec(sql);
    },
    async transaction(fn) {
      nativeDb.exec('BEGIN IMMEDIATE;');
      try {
        const result = await fn();
        nativeDb.exec('COMMIT;');
        return result;
      } catch (err) {
        try {
          nativeDb.exec('ROLLBACK;');
        } catch (_) {}
        throw err;
      }
    },
  };
}

function normalizeRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

function createTursoAdapter(slug, tursoCfg, storeName) {
  const client = createClient({
    url: tursoCfg.url,
    authToken: tursoCfg.authToken,
  });

  async function ensureSchema() {
    if (schemaInitialized.has(tursoCfg.url)) return;
    await client.execute('PRAGMA foreign_keys = ON;');
    await client.executeMultiple(buildSchemaSQL(storeName));
    schemaInitialized.add(tursoCfg.url);
  }

  return {
    isTurso: true,
    client,
    async get(sql, ...params) {
      await ensureSchema();
      const activeTx = txStorage.getStore();
      const target = activeTx || client;
      const res = await target.execute({ sql, args: params });
      return normalizeRow(res.rows[0]);
    },
    async all(sql, ...params) {
      await ensureSchema();
      const activeTx = txStorage.getStore();
      const target = activeTx || client;
      const res = await target.execute({ sql, args: params });
      return res.rows.map(normalizeRow);
    },
    async run(sql, ...params) {
      await ensureSchema();
      const activeTx = txStorage.getStore();
      const target = activeTx || client;
      const res = await target.execute({ sql, args: params });
      return {
        lastInsertRowid: Number(res.lastInsertRowid || 0),
        changes: Number(res.rowsAffected || 0),
      };
    },
    async exec(sql) {
      await ensureSchema();
      await client.executeMultiple(sql);
    },
    async transaction(fn) {
      await ensureSchema();
      const tx = await client.transaction('write');
      try {
        const result = await txStorage.run(tx, fn);
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch (_) {}
        throw err;
      }
    },
  };
}

function getTenantAdapter(slugOverride = null) {
  const ctx = tenantStorage.getStore();
  const slug = slugOverride || ctx?.slug || DEFAULT_TENANT;
  const tursoCfg = !process.env.DB_PATH ? getTursoConfig(slug) : null;
  const cacheKey = tursoCfg ? `turso:${tursoCfg.url}` : `local:${getTenantPaths(slug).dbPath}`;

  if (adapterCache.has(cacheKey)) {
    return adapterCache.get(cacheKey);
  }

  const tenantRow = masterDb.prepare('SELECT name FROM tenants WHERE slug = ?').get(slug);
  const storeName = tenantRow?.name || slug.toUpperCase();

  const adapter = tursoCfg
    ? createTursoAdapter(slug, tursoCfg, storeName)
    : createLocalAdapter(getTenantPaths(slug).dbPath, storeName);

  adapterCache.set(cacheKey, adapter);
  return adapter;
}

const db = {
  get(sql, ...params) {
    return getTenantAdapter().get(sql, ...params);
  },
  all(sql, ...params) {
    return getTenantAdapter().all(sql, ...params);
  },
  run(sql, ...params) {
    return getTenantAdapter().run(sql, ...params);
  },
  exec(sql) {
    return getTenantAdapter().exec(sql);
  },
};

function getCurrentTenantSlug() {
  return tenantStorage.getStore()?.slug || DEFAULT_TENANT;
}

function runTransaction(fn) {
  return getTenantAdapter().transaction(fn);
}

function getTenant(slug) {
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug || '').toLowerCase());
}

function listTenants() {
  return masterDb.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all();
}

function createTenant(slug, name, tursoUrl = '', tursoToken = '') {
  const cleanSlug = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!cleanSlug || cleanSlug.length < 2) {
    throw new Error('Subdomínio (slug) inválido. Use apenas letras minúsculas, números e hífen.');
  }
  const existing = getTenant(cleanSlug);
  if (existing) {
    throw new Error(`Já existe um sistema cadastrado com o subdomínio "${cleanSlug}".`);
  }
  masterDb
    .prepare('INSERT INTO tenants (slug, name, active, turso_url, turso_token) VALUES (?, ?, 1, ?, ?)')
    .run(cleanSlug, String(name || cleanSlug).trim(), String(tursoUrl || '').trim(), String(tursoToken || '').trim());
  return getTenant(cleanSlug);
}

function setTenantActive(slug, active) {
  const cleanSlug = String(slug || '').toLowerCase();
  const res = masterDb
    .prepare('UPDATE tenants SET active = ? WHERE slug = ?')
    .run(active ? 1 : 0, cleanSlug);
  if (res.changes === 0) throw new Error('Sistema/cliente não encontrado.');
  return getTenant(cleanSlug);
}

module.exports = {
  db,
  masterDb,
  tenantStorage,
  DATA_DIR,
  DEFAULT_TENANT,
  getTenantAdapter,
  getTenantPaths,
  getCurrentTenantSlug,
  runTransaction,
  getTenant,
  listTenants,
  createTenant,
  setTenantActive,
};
