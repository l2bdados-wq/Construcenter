const path = require('node:path');
const fs = require('node:fs');
const {
  getTenantDb,
  getTenantPaths,
  getCurrentTenantSlug,
  listTenants,
} = require('../db/database');

const MAX_BACKUPS = 30;
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function createBackup(prefix = 'auto', slugOverride = null) {
  const slug = slugOverride || getCurrentTenantSlug();
  const { backupDir } = getTenantPaths(slug);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `${slug}_${prefix}_${stamp}.db`;
  const dest = path.join(backupDir, filename);

  const escaped = dest.replace(/'/g, "''");
  getTenantDb(slug).exec(`VACUUM INTO '${escaped}';`);

  pruneOldBackups(slug);
  const stat = fs.statSync(dest);
  return { filename, path: dest, size: stat.size, createdAt: now.toISOString() };
}

function listBackups(slugOverride = null) {
  const slug = slugOverride || getCurrentTenantSlug();
  const { backupDir } = getTenantPaths(slug);
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = path.join(backupDir, f);
      const stat = fs.statSync(full);
      return {
        filename: f,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneOldBackups(slugOverride = null) {
  const slug = slugOverride || getCurrentTenantSlug();
  const { backupDir } = getTenantPaths(slug);
  const files = listBackups(slug);
  if (files.length <= MAX_BACKUPS) return;
  for (const old of files.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(backupDir, old.filename));
    } catch (_) {
      // ignore
    }
  }
}

function runBackupAllTenants() {
  const tenants = listTenants().filter((t) => t.active);
  const sixHoursAgo = Date.now() - AUTO_INTERVAL_MS;
  for (const t of tenants) {
    try {
      const backups = listBackups(t.slug);
      const hasRecent = backups.some((b) => new Date(b.createdAt).getTime() > sixHoursAgo);
      if (!hasRecent) {
        createBackup('auto', t.slug);
      }
    } catch (err) {
      console.error(`Erro no backup automático (${t.slug}):`, err.message);
    }
  }
}

function startAutoBackup() {
  runBackupAllTenants();
  const timer = setInterval(runBackupAllTenants, AUTO_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  createBackup,
  listBackups,
  startAutoBackup,
};
