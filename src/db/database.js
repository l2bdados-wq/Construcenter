const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || 'construcenter').toLowerCase();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });

const tenantStorage = new AsyncLocalStorage();
const dbCache = new Map();

// Master database for tenant registry (ignored when single-file DB_PATH is forced for tests)
const MASTER_DB_PATH = path.join(DATA_DIR, 'master.db');
const masterDb = new DatabaseSync(MASTER_DB_PATH);
masterDb.exec('PRAGMA journal_mode = WAL;');
masterDb.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// Seed default tenant 'construcenter'
masterDb
  .prepare('INSERT OR IGNORE INTO tenants (slug, name, active) VALUES (?, ?, 1)')
  .run('construcenter', 'CONSTRUCENTER');

function initTenantSchema(database, storeName = 'CONSTRUCENTER') {
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');

  database.exec(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'CONSTRUCENTER',
      subtitle TEXT NOT NULL DEFAULT 'Materiais para Construção e Elétrica em Geral',
      cnpj TEXT DEFAULT '',
      phone TEXT NOT NULL DEFAULT '(77) 9.9963-2028',
      address TEXT DEFAULT '',
      footer_note TEXT DEFAULT 'Pedido — sem valor fiscal'
    );

    INSERT OR IGNORE INTO store_settings (id, name) VALUES (1, '${storeName.replace(/'/g, "''")}');

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
  `);
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

  // Legacy single-tenant DB support for default tenant if data/construcenter.db already exists
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

function getTenantDb(slugOverride = null) {
  const ctx = tenantStorage.getStore();
  const slug = slugOverride || ctx?.slug || DEFAULT_TENANT;
  const paths = getTenantPaths(slug);

  if (dbCache.has(paths.dbPath)) {
    return dbCache.get(paths.dbPath);
  }

  const database = new DatabaseSync(paths.dbPath);
  const tenantRow = masterDb.prepare('SELECT name FROM tenants WHERE slug = ?').get(slug);
  initTenantSchema(database, tenantRow?.name || slug.toUpperCase());
  dbCache.set(paths.dbPath, database);
  return database;
}

// Proxy so existing `db.prepare(...)` and `db.exec(...)` work transparently per tenant
const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const activeDb = getTenantDb();
      const val = activeDb[prop];
      return typeof val === 'function' ? val.bind(activeDb) : val;
    },
  }
);

function getCurrentTenantSlug() {
  return tenantStorage.getStore()?.slug || DEFAULT_TENANT;
}

function runTransaction(fn) {
  const activeDb = getTenantDb();
  activeDb.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    activeDb.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      activeDb.exec('ROLLBACK;');
    } catch (_) {
      // ignore rollback error
    }
    throw err;
  }
}

function getTenant(slug) {
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug || '').toLowerCase());
}

function listTenants() {
  return masterDb.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all();
}

function createTenant(slug, name) {
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
    .prepare('INSERT INTO tenants (slug, name, active) VALUES (?, ?, 1)')
    .run(cleanSlug, String(name || cleanSlug).trim());
  // Initialize its database immediately
  getTenantDb(cleanSlug);
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
  getTenantDb,
  getTenantPaths,
  getCurrentTenantSlug,
  runTransaction,
  getTenant,
  listTenants,
  createTenant,
  setTenantActive,
};
