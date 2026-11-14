import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';
import { requireRole, assertCustomerAccess } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { notFound } from '../middleware/error.js';
import { idParams } from '../validators/common.js';
import { customerQuery, createCustomerBody, updateCustomerBody, paymentBody, paymentQuery } from '../validators/catalog.js';
import { recordPayment } from '../services/payments.js';

export const customers = Router();
const staff = requireRole('staff', 'owner');

customers.get('/', staff, validate({ query: customerQuery }), async (req, res) => {
  const { q, limit, offset } = req.valid.query;
  const params = [limit, offset];
  let where = '';
  if (q) { params.push(`%${q}%`); where = `where c.name ilike $3 or c.phone ilike $3`; }
  const { rows } = await pool.query(
    `select c.*, (select max(created_at) from payments p where p.customer_id = c.id) as last_payment_at,
            exists (select 1 from users u where u.customer_id = c.id) as has_login
     from customers c ${where} order by c.name limit $1 offset $2`, params);
  res.json({ customers: rows });
});

customers.post('/', requireRole('owner'), validate({ body: createCustomerBody }), async (req, res) => {
  const b = req.valid.body;
  const customer = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into customers (name, phone, preferred_language, address, credit_limit) values ($1,$2,$3,$4,$5) returning *`,
      [b.name, b.phone, b.preferred_language ?? null, b.address ?? null, b.credit_limit]);
    if (b.password) {
      await client.query(
        `insert into users (phone, name, password_hash, role, customer_id) values ($1,$2,$3,'customer',$4)`,
        [b.phone, b.name, await bcrypt.hash(b.password, 10), rows[0].id]);
    }
    return rows[0];
  });
  res.status(201).json({ customer });
});

async function customerSummary(id) {
  const [c, ledger, payments, invoices] = await Promise.all([
    pool.query('select * from customers where id = $1', [id]),
    pool.query('select * from customer_ledger where customer_id = $1 order by created_at desc, id desc limit 50', [id]),
    pool.query('select id, amount, method, reference, created_at from payments where customer_id = $1 order by created_at desc limit 50', [id]),
    pool.query(
      `select i.id, i.invoice_no, i.total, i.created_at, o.order_no, o.id as order_id from invoices i
       join orders o on o.id = i.order_id where i.customer_id = $1 order by i.created_at desc limit 50`, [id]),
  ]);
  if (!c.rows[0]) throw notFound('Customer not found.');
  return { customer: c.rows[0], ledger: ledger.rows, payments: payments.rows, invoices: invoices.rows };
}

customers.get('/me', requireRole('customer'), async (req, res) => res.json(await customerSummary(req.user.customer_id)));

customers.get('/:id', validate({ params: idParams }), async (req, res) => {
  assertCustomerAccess(req.user, req.valid.params.id);
  res.json(await customerSummary(req.valid.params.id));
});

customers.patch('/:id', requireRole('owner'), validate({ params: idParams, body: updateCustomerBody }), async (req, res) => {
  const fields = Object.entries(req.valid.body);
  const { rows } = await pool.query(
    `update customers set ${fields.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
    [req.valid.params.id, ...fields.map(([, v]) => v)]);
  if (!rows[0]) throw notFound('Customer not found.');
  res.json({ customer: rows[0] });
});

export const payments = Router();

payments.get('/', validate({ query: paymentQuery }), async (req, res) => {
  const { limit, offset } = req.valid.query;
  const customerId = req.user.role === 'customer' ? req.user.customer_id : req.valid.query.customer_id;
  const { rows } = await pool.query(
    `select p.*, c.name as customer_name from payments p join customers c on c.id = p.customer_id
     ${customerId ? 'where p.customer_id = $3' : ''} order by p.created_at desc limit $1 offset $2`,
    customerId ? [limit, offset, customerId] : [limit, offset]);
  res.json({ payments: rows });
});

payments.post('/', staff, validate({ body: paymentBody }), async (req, res) => {
  const b = req.valid.body;
  const result = await withTransaction((client) => recordPayment(client, {
    customerId: b.customer_id, amount: b.amount, method: b.method, reference: b.reference,
    note: b.note, idempotencyKey: b.idempotency_key, userId: req.user.id,
  }));
  const { rows } = await pool.query('select balance from customers where id = $1', [b.customer_id]);
  res.status(result.duplicate ? 200 : 201).json({ ...result, balance: rows[0].balance });
});
