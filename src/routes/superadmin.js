const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const {
  listTenants,
  createTenant,
  setTenantActive,
  getTenantPaths,
} = require('../db/database');
const { BASE_DOMAIN } = require('../middleware/tenant');

const router = express.Router();

function requireSuperAdmin(req, res, next) {
  const configuredKey = process.env.SUPER_ADMIN_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'SUPER_ADMIN_KEY não configurada no servidor.' });
  }
  const provided = req.headers['x-super-admin-key'] || '';
  if (!provided || provided !== configuredKey) {
    return res.status(401).json({ error: 'Chave de Super-Administrador inválida.' });
  }
  next();
}

router.use(requireSuperAdmin);

router.get('/tenants', (req, res) => {
  const tenants = listTenants().map((t) => ({
    ...t,
    url: `https://${t.slug}.${BASE_DOMAIN}`,
  }));
  res.json({ base_domain: BASE_DOMAIN, tenants });
});

router.post('/tenants', (req, res) => {
  const { slug, name } = req.body || {};
  try {
    const created = createTenant(slug, name);
    res.status(201).json({
      ...created,
      url: `https://${created.slug}.${BASE_DOMAIN}`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/tenants/:slug/status', (req, res) => {
  const { active } = req.body || {};
  try {
    const updated = setTenantActive(req.params.slug, Boolean(active));
    res.json(updated);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/tenants/:slug/logo', (req, res) => {
  const { contentBase64 } = req.body || {};
  if (!contentBase64) return res.status(400).json({ error: 'Imagem não enviada.' });
  const paths = getTenantPaths(req.params.slug);
  const dest = path.join(paths.dir, 'logo.jpeg');
  fs.writeFileSync(dest, Buffer.from(contentBase64, 'base64'));
  res.json({ ok: true });
});

module.exports = router;
