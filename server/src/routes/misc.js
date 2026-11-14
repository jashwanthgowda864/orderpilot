import { Router } from 'express';
import { pool } from '../db.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { notFound } from '../middleware/error.js';
import { idParams, pagination } from '../validators/common.js';
import { shopBody } from '../validators/catalog.js';
import { z } from 'zod';
import { geminiStatus } from '../services/gemini.js';
import { storageMode } from '../services/storage.js';
import { config } from '../config.js';

export const invoices = Router();
invoices.get('/:id', validate({ params: idParams }), async (req, res) => {
  const { rows } = await pool.query(
    `select i.*, o.order_no, c.name as customer_name, c.phone as customer_phone from invoices i
     join orders o on o.id = i.order_id join customers c on c.id = i.customer_id where i.id = $1`, [req.valid.params.id]);
  const inv = rows[0];
  if (!inv || (req.user.role === 'customer' && inv.customer_id !== req.user.customer_id)) throw notFound('Invoice not found.');
  const shop = (await pool.query('select name, phone, address, tax_rate, currency from shop_settings where id = 1')).rows[0];
  res.json({ invoice: inv, shop });
});

export const settings = Router();
settings.get('/shop', async (req, res) => {
  const { rows } = await pool.query('select name, phone, address, tax_rate, currency from shop_settings where id = 1');
  res.json({
    shop: rows[0] || null,
    ai: geminiStatus(),
    storage: storageMode,
    substitution_wait_minutes: config.substitutionWaitMinutes,
  });
});
settings.patch('/shop', requireRole('owner'), validate({ body: shopBody }), async (req, res) => {
  const fields = Object.entries(req.valid.body);
  const { rows } = await pool.query(
    `update shop_settings set ${fields.map(([k], i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() where id = 1 returning *`,
    fields.map(([, v]) => v));
  res.json({ shop: rows[0] });
});

export const dashboard = Router();
dashboard.use(requireRole('owner'));
dashboard.get('/', async (req, res) => {
  const [byStatus, today, week, outstanding, lowStock] = await Promise.all([
    pool.query(`select status, count(*)::int as count from orders group by status`),
    pool.query(`select coalesce(sum(total),0) as total, count(*)::int as count from invoices where created_at >= date_trunc('day', now())`),
    pool.query(`select coalesce(sum(total),0) as total, count(*)::int as count from invoices where created_at >= now() - interval '7 days'`),
    pool.query(`select coalesce(sum(balance) filter (where balance > 0),0) as total, count(*) filter (where balance > 0)::int as customers from customers`),
    pool.query(`select id, sku, name, stock_qty, reorder_level from products where active and stock_qty <= reorder_level order by stock_qty limit 20`),
  ]);
  res.json({
    orders_by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    sales_today: today.rows[0], sales_7d: week.rows[0], outstanding: outstanding.rows[0], low_stock: lowStock.rows,
  });
});

export const aiEvents = Router();
aiEvents.use(requireRole('owner'));
aiEvents.get('/', validate({ query: z.strictObject(pagination) }), async (req, res) => {
  const { rows } = await pool.query(
    `select id, kind, status, model, mock, order_id, input_summary, error, latency_ms, created_at
     from ai_events order by id desc limit $1 offset $2`, [req.valid.query.limit, req.valid.query.offset]);
  res.json({ events: rows });
});
