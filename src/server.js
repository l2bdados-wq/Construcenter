const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const fs = require('node:fs');

const { getTenantPaths, getCurrentTenantSlug } = require('./db/database');
const { tenantMiddleware } = require('./middleware/tenant');
const { startAutoBackup } = require('./services/backup');
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const productRoutes = require('./routes/products');
const { router: withdrawalRoutes } = require('./routes/withdrawals');
const orderRoutes = require('./routes/orders');
const reportRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const superadminRoutes = require('./routes/superadmin');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));
  app.use(cookieParser());

  // Super-Admin API (L2 Sistemas)
  app.use('/api/superadmin', superadminRoutes);

  // Resolve tenant by subdomain (e.g. construcenter.l2sistemas.api.br)
  app.use(tenantMiddleware);

  // Serve tenant logo.jpeg (or default logo.jpeg)
  app.get('/logo.jpeg', (req, res) => {
    const { logoPath } = getTenantPaths(getCurrentTenantSlug());
    if (fs.existsSync(logoPath)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(logoPath);
    }
    res.status(404).end();
  });

  // Portal L2 Sistemas when accessed on root domain l2sistemas.api.br
  app.get('/', (req, res, next) => {
    if (req.isPortal) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(path.join(__dirname, '..', 'public', 'portal.html'));
    }
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/customers', customerRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/withdrawals', withdrawalRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      etag: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
      },
    })
  );

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({
      error: err.message || 'Erro interno no servidor.',
    });
  });

  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const app = createApp();
  startAutoBackup();
  app.listen(PORT, HOST, () => {
    console.log(`L2 Sistemas (Construcenter & Multi-Tenant) rodando em http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
