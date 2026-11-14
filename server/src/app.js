import express from 'express';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import { products, stock } from './routes/products.js';
import { customers, payments } from './routes/customers.js';
import { invoices, settings, dashboard, aiEvents } from './routes/misc.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    // Same-origin in production (served behind one host); allow the Vite dev origin.
    const origin = req.headers.origin;
    if (origin && origin === config.corsOrigin) {
      res.set('access-control-allow-origin', origin);
      res.set('access-control-allow-headers', 'authorization, content-type');
      res.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      res.set('vary', 'origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    res.set('x-content-type-options', 'nosniff');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  // Everything below requires a valid JWT.
  app.use('/api', requireAuth);
  app.use('/api/orders', orderRoutes);
  app.use('/api/products', products);
  app.use('/api/stock', stock);
  app.use('/api/customers', customers);
  app.use('/api/payments', payments);
  app.use('/api/invoices', invoices);
  app.use('/api/settings', settings);
  app.use('/api/dashboard', dashboard);
  app.use('/api/ai-events', aiEvents);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
