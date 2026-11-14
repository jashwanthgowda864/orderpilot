import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { notFound } from '../middleware/error.js';
import { idParams } from '../validators/common.js';
import { createProductBody, updateProductBody, stockMovementBody, stockQuery } from '../validators/catalog.js';
import { applyMovement } from '../services/stock.js';

export const products = Router();
const owner = requireRole('owner');

products.get('/', async (req, res) => {
  const isCustomer = req.user.role === 'customer';
  const { rows } = await pool.query(
    `select id, sku, name, name_kn, name_hi, aliases, category, unit, pack_size, price, active,
            ${isCustomer ? '(stock_qty > 0) as in_stock' : 'stock_qty, reorder_level, substitute_group, (stock_qty > 0) as in_stock'}
     from products ${isCustomer ? 'where active' : ''} order by category, name`);
  res.json({ products: rows });
});

products.post('/', owner, validate({ body: createProductBody }), async (req, res) => {
  const { opening_stock, ...p } = req.valid.body;
  const product = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into products (sku, name, name_kn, name_hi, aliases, category, unit, pack_size, price, reorder_level, substitute_group, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [p.sku.toUpperCase(), p.name, p.name_kn ?? null, p.name_hi ?? null, p.aliases, p.category, p.unit, p.pack_size, p.price, p.reorder_level, p.substitute_group ?? null, p.active]);
    if (opening_stock > 0) {
      await applyMovement(client, { productId: rows[0].id, type: 'inward', quantity: opening_stock, refType: 'manual', note: 'Opening stock', userId: req.user.id });
    }
    return (await client.query('select * from products where id = $1', [rows[0].id])).rows[0];
  });
  res.status(201).json({ product });
});

products.patch('/:id', owner, validate({ params: idParams, body: updateProductBody }), async (req, res) => {
  const fields = Object.entries(req.valid.body);
  const { rows } = await pool.query(
    `update products set ${fields.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
    [req.valid.params.id, ...fields.map(([, v]) => v)]);
  if (!rows[0]) throw notFound('Product not found.');
  res.json({ product: rows[0] });
});

export const stock = Router();
stock.use(owner);

stock.get('/movements', validate({ query: stockQuery }), async (req, res) => {
  const { product_id, limit, offset } = req.valid.query;
  const { rows } = await pool.query(
    `select m.*, p.sku, p.name, u.name as created_by_name from stock_movements m
     join products p on p.id = m.product_id left join users u on u.id = m.created_by
     ${product_id ? 'where m.product_id = $3' : ''} order by m.created_at desc, m.id desc limit $1 offset $2`,
    product_id ? [limit, offset, product_id] : [limit, offset]);
  res.json({ movements: rows });
});

stock.post('/movements', validate({ body: stockMovementBody }), async (req, res) => {
  const b = req.valid.body;
  const product = await withTransaction((client) => applyMovement(client, {
    productId: b.product_id, type: b.type, quantity: b.quantity, unitCost: b.unit_cost,
    refType: 'manual', note: b.note, userId: req.user.id,
  }));
  res.status(201).json({ product });
});
