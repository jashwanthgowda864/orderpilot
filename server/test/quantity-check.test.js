// Quantity anomaly check before submit. Local database, no AI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
let server; let base; const tok = {}; const created = [];
const api = async (who, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const counterOrder = async (phone, items) => {
  const c = (await pool.query('select id from customers where phone = $1', [phone])).rows[0];
  const r = await api('staff', 'POST', '/orders', { customer_id: c.id, items });
  created.push(r.body.order.id);
  return r.body.order;
};
/** Median past quantity of a SKU for a customer (same rule as the server). */
async function usual(phone, sku) {
  const q = (await pool.query(
    `select i.quantity from order_items i join orders o on o.id = i.order_id join customers c on c.id = o.customer_id
     where c.phone = $1 and i.sku = $2 and o.status in ('collected','ready') and coalesce(i.origin,'') <> 'substitution'`, [phone, sku])).rows.map((r) => Number(r.quantity)).sort((a, b) => a - b);
  if (!q.length) return null;
  const m = Math.floor(q.length / 2);
  return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2;
}

before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['staff', '9000000002'], ['ramesh', '9000000101'], ['fatima', '9000000102']]) {
    tok[who] = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: PASSWORD }) })).json()).token;
  }
});
after(async () => {
  for (const id of created) await api('staff', 'POST', `/orders/${id}/cancel`, {}).catch(() => {});
  server.close(); await pool.end();
});

test('warns when a quantity is more than 3x the usual, not for normal amounts', async () => {
  const u = await usual('9000000101', 'TOOR-1KG');
  assert.ok(u, 'fixture: Ramesh has toor dal history');
  const big = Math.floor(3 * u) + 1;
  const o = await counterOrder('9000000101', [{ sku: 'TOOR-1KG', quantity: big }, { sku: 'SUGAR-1KG', quantity: 1 }]);
  const r = await api('ramesh', 'GET', `/orders/${o.id}/quantity-check`);
  assert.equal(r.status, 200);
  assert.equal(r.body.warnings.length, 1);
  assert.equal(r.body.warnings[0].sku, 'TOOR-1KG');
  assert.match(r.body.warnings[0].message, new RegExp(`You usually order ${u}.*Confirm ${big}\\?`));
  // Exactly 3x is still fine.
  const ok = await counterOrder('9000000101', [{ sku: 'TOOR-1KG', quantity: Math.max(1, Math.floor(3 * u)) }]);
  assert.deepEqual((await api('staff', 'GET', `/orders/${ok.id}/quantity-check`)).body.warnings, []);
});

test('a product never ordered before warns only when the quantity is large', async () => {
  const sku = 'JEERA-100G';
  assert.equal(await usual('9000000101', sku), null, 'fixture: Ramesh never ordered jeera');
  const large = await counterOrder('9000000101', [{ sku, quantity: 10 }]);
  const w = (await api('staff', 'GET', `/orders/${large.id}/quantity-check`)).body.warnings;
  assert.equal(w.length, 1); assert.match(w[0].message, /haven't ordered .* before\. Confirm 10\?/);
  const small = await counterOrder('9000000101', [{ sku, quantity: 2 }]);
  assert.deepEqual((await api('staff', 'GET', `/orders/${small.id}/quantity-check`)).body.warnings, []);
});

test('no history -> no warning; customers cannot check other customers\' orders; every check is logged', async () => {
  const o = await counterOrder('9000000199', [{ sku: 'SUGAR-1KG', quantity: 50 }]);
  const r = await api('staff', 'GET', `/orders/${o.id}/quantity-check`);
  assert.deepEqual([r.body.warnings, r.body.has_history], [[], false]);
  assert.equal((await api('fatima', 'GET', `/orders/${o.id}/quantity-check`)).status, 404);
  const n = (await pool.query(`select count(*)::int n from ai_events where kind = 'quantity_check' and order_id = $1`, [o.id])).rows[0].n;
  assert.equal(n, 1);
});
