const {
  tenantStorage,
  DEFAULT_TENANT,
  getTenant,
} = require('../db/database');

const BASE_DOMAIN = (process.env.BASE_DOMAIN || 'l2sistemas.api.br').toLowerCase();

function resolveHostSlug(req) {
  // Explicit header override for automated tests / reverse proxies
  if (req.headers['x-tenant']) {
    return { mode: 'tenant', slug: String(req.headers['x-tenant']).trim().toLowerCase() };
  }

  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const host = rawHost.split(':')[0].toLowerCase();

  if (host === BASE_DOMAIN || host === `www.${BASE_DOMAIN}`) {
    return { mode: 'portal', slug: null };
  }

  if (host.endsWith(`.${BASE_DOMAIN}`)) {
    const slug = host.slice(0, -(BASE_DOMAIN.length + 1));
    if (slug === 'portal') return { mode: 'portal', slug: null };
    return { mode: 'tenant', slug };
  }

  // Localhost, 127.0.0.1, or LAN IP -> default tenant (e.g. construcenter)
  return { mode: 'tenant', slug: DEFAULT_TENANT };
}

function tenantMiddleware(req, res, next) {
  if (req.path.startsWith('/api/superadmin')) {
    return next();
  }

  const resolved = resolveHostSlug(req);

  if (resolved.mode === 'portal') {
    req.isPortal = true;
    return next();
  }

  const tenant = getTenant(resolved.slug);
  if (!tenant) {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({
        error: `Sistema "${resolved.slug}" não encontrado em ${BASE_DOMAIN}.`,
      });
    }
    return res.status(404).send(`
      <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Sistema não encontrado</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f4f5f7;color:#1e2022">
        <h1>L2 Sistemas</h1>
        <p>O sistema <strong>${resolved.slug}.${BASE_DOMAIN}</strong> não foi encontrado.</p>
      </body></html>
    `);
  }

  if (!tenant.active) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({
        error: 'Sistema temporariamente suspenso. Entre em contato com o suporte da L2 Sistemas.',
      });
    }
    return res.status(403).send(`
      <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Sistema Suspenso</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f4f5f7;color:#1e2022">
        <h1>L2 Sistemas</h1>
        <p>O acesso ao sistema <strong>${tenant.name}</strong> está temporariamente suspenso.</p>
      </body></html>
    `);
  }

  req.tenant = tenant;
  tenantStorage.run({ slug: tenant.slug, tenant }, next);
}

module.exports = {
  BASE_DOMAIN,
  tenantMiddleware,
};
