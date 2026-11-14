// End-to-end test of the core workflow against a real Postgres (DATABASE_URL).
// Run after `npm run migrate` and `npm run seed`. Gemini must be in mock mode
// (no GEMINI_API_KEY) so results are deterministic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
let server; let base; const tok = {};

async function api(who, method, path, body, { form } = {}) {
  const headers = {};
  if (tok[who]) headers.authorization = `Bearer ${tok[who]}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

before(async () => {
  assert.ok(config.gemini.mock, 'Tests expect Gemini mock mode (unset GEMINI_API_KEY).');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['owner', '9000000001'], ['staff', '9000000002'], ['ramesh', '9000000101'], ['fatima', '9000000102']]) {
    const r = await api(null, 'POST', '/auth/login', { phone, password: PASSWORD });
    assert.equal(r.status, 200, `login ${who}`);
    tok[who] = r.body.token;
  }
});
after(async () => { server.close(); await pool.end(); });

test('auth and validation basics', async () => {
  assert.equal((await api(null, 'POST', '/auth/login', { phone: '9000000001', password: 'wrong' })).status, 401);
  assert.equal((await api(null, 'GET', '/orders')).status, 401);
  // Unknown fields rejected.
  assert.equal((await api(null, 'POST', '/auth/login', { phone: '9000000001', password: PASSWORD, admin: true })).status, 400);
  // Customers cannot reach owner-only routes.
  assert.equal((await api('ramesh', 'GET', '/dashboard')).status, 403);
  assert.equal((await api('staff', 'GET', '/dashboard')).status, 403);
  assert.equal((await api('owner', 'GET', '/dashboard')).status, 200);
});

test('text order -> clarification -> review -> submit -> approve -> pick -> finish packing -> collect', async () => {
  const cust = await one(`select id, balance from customers where phone = '9000000101'`);
  const sugarBefore = await one(`select id, stock_qty, price from products where sku = 'SUGAR-1KG'`);
  const dalBefore = await one(`select id, stock_qty, price from products where sku = 'TOOR-1KG'`);
  const key = randomUUID();

  const form = new FormData();
  form.set('text', '2 kg sugar, toor dal 2, 3 basmati');
  form.set('idempotency_key', key);
  let r = await api('ramesh', 'POST', '/orders/parse', null, { form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let order = r.body.order;
  assert.equal(order.status, 'needs_clarification');
  assert.equal(order.items.length, 3);
  const sugar = order.items.find((i) => i.sku === 'SUGAR-1KG');
  assert.equal(sugar.quantity, 2);
  assert.equal(sugar.confidence, 'high');
  assert.ok(order.items[0].stock_qty === undefined, 'customers must not see stock levels');

  // Same idempotency key -> same order, no duplicate.
  const form2 = new FormData(); form2.set('text', '2 kg sugar, toor dal 2, 3 basmati'); form2.set('idempotency_key', key);
  r = await api('ramesh', 'POST', '/orders/parse', null, { form: form2 });
  assert.equal(r.status, 200); assert.equal(r.body.order.id, order.id);

  // Another customer cannot see it.
  assert.equal((await api('fatima', 'GET', `/orders/${order.id}`)).status, 404);

  // Answer: skip the unknown item.
  const q = order.clarifications.find((c) => !c.answered_at);
  assert.equal(q.kind, 'choose_product');
  r = await api('ramesh', 'POST', `/orders/${order.id}/clarifications/${q.id}/answer`, { skip: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  order = r.body.order;
  assert.equal(order.status, 'draft');
  assert.equal(order.items.length, 2);

  // Review edit: change dal to 1, add 1 salt.
  const dal = order.items.find((i) => i.sku === 'TOOR-1KG');
  r = await api('ramesh', 'PUT', `/orders/${order.id}/items`, { items: [
    { id: order.items.find((i) => i.sku === 'SUGAR-1KG').id, sku: 'SUGAR-1KG', quantity: 2 },
    { id: dal.id, sku: 'TOOR-1KG', quantity: 1 },
    { sku: 'SALT-1KG', quantity: 1 },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  order = r.body.order;
  assert.equal(order.items.length, 3);
  // Whole packs enforced.
  assert.equal((await api('ramesh', 'PUT', `/orders/${order.id}/items`, { items: [{ sku: 'SALT-1KG', quantity: 1.5 }] })).status, 200,
    'salt 1 kg pack allows fractions (loose by kg)');
  assert.equal((await api('ramesh', 'PUT', `/orders/${order.id}/items`, { items: [{ sku: 'BUTTER-100G', quantity: 1.5 }] })).status, 400);
  r = await api('ramesh', 'PUT', `/orders/${order.id}/items`, { items: [
    { sku: 'SUGAR-1KG', quantity: 2 }, { sku: 'TOOR-1KG', quantity: 1 }, { sku: 'SALT-1KG', quantity: 1 }] });
  order = r.body.order;

  r = await api('ramesh', 'POST', `/orders/${order.id}/submit`);
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'submitted');
  assert.equal((await api('ramesh', 'PUT', `/orders/${order.id}/items`, { items: [{ sku: 'SALT-1KG', quantity: 1 }] })).status, 409);

  // Customers cannot approve.
  assert.equal((await api('ramesh', 'POST', `/orders/${order.id}/approve`, {})).status, 403);
  r = await api('staff', 'POST', `/orders/${order.id}/approve`, {});
  assert.equal(r.status, 200); assert.equal(r.body.order.status, 'approved');
  // Cannot finish packing before picking.
  assert.equal((await api('staff', 'POST', `/orders/${order.id}/finish-packing`, {})).status, 409);

  r = await api('staff', 'POST', `/orders/${order.id}/start-picking`);
  assert.equal(r.body.order.status, 'picking');
  const queue = (await api('staff', 'GET', '/orders/pick-queue')).body.queue;
  assert.ok(queue.some((o) => o.id === order.id));

  order = r.body.order;
  const iSugar = order.items.find((i) => i.sku === 'SUGAR-1KG');
  const iDal = order.items.find((i) => i.sku === 'TOOR-1KG');
  const iSalt = order.items.find((i) => i.sku === 'SALT-1KG');
  // Sugar short (1 of 2), salt unavailable, dal left pending.
  assert.equal((await api('staff', 'PATCH', `/orders/${order.id}/items/${iSugar.id}/pick`, { pick_status: 'short', packed_qty: 1 })).status, 200);
  assert.equal((await api('staff', 'PATCH', `/orders/${order.id}/items/${iSalt.id}/pick`, { pick_status: 'unavailable' })).status, 200);
  assert.equal((await api('staff', 'PATCH', `/orders/${order.id}/items/${iSugar.id}/pick`, { pick_status: 'packed', packed_qty: 5 })).status, 400);
  // Pending item blocks finish unless pack_remaining; pending substitute blocks unless proceed_without_substitutes.
  assert.equal((await api('staff', 'POST', `/orders/${order.id}/finish-packing`, {})).status, 409);
  const subBlock = await api('staff', 'POST', `/orders/${order.id}/finish-packing`, { pack_remaining: true });
  assert.equal(subBlock.status, 409);
  assert.ok(subBlock.body.details.pending_substitutions.length >= 1);

  // Two concurrent finish-packing calls -> exactly one invoice and one stock deduction.
  const [a, b] = await Promise.all([
    api('staff', 'POST', `/orders/${order.id}/finish-packing`, { pack_remaining: true, proceed_without_substitutes: true }),
    api('owner', 'POST', `/orders/${order.id}/finish-packing`, { pack_remaining: true, proceed_without_substitutes: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 200], JSON.stringify([a.body, b.body]));
  order = (await api('staff', 'GET', `/orders/${order.id}`)).body.order;
  assert.equal(order.status, 'ready');
  const expected = sugarBefore.price * 1 + dalBefore.price * 1;
  assert.equal(order.invoice.total, expected);
  assert.equal((await one('select count(*)::int n from invoices where order_id = $1', [order.id])).n, 1);

  const sugarAfter = await one(`select stock_qty from products where sku = 'SUGAR-1KG'`);
  const dalAfter = await one(`select stock_qty from products where sku = 'TOOR-1KG'`);
  assert.equal(sugarAfter.stock_qty, sugarBefore.stock_qty - 1);
  assert.equal(dalAfter.stock_qty, dalBefore.stock_qty - 1);
  const custAfterPack = await one('select balance from customers where id = $1', [cust.id]);
  assert.equal(custAfterPack.balance, Math.round((cust.balance + expected) * 100) / 100);

  // Idempotent repeat.
  r = await api('staff', 'POST', `/orders/${order.id}/finish-packing`, {});
  assert.equal(r.status, 200); assert.equal(r.body.duplicate, true);
  assert.equal((await one(`select stock_qty from products where sku = 'SUGAR-1KG'`)).stock_qty, sugarAfter.stock_qty);

  // Collect with payment; repeat is a no-op.
  const payKey = randomUUID();
  r = await api('staff', 'POST', `/orders/${order.id}/collect`, { payment: { amount: expected, method: 'cash', idempotency_key: payKey } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.order.status, 'collected');
  r = await api('staff', 'POST', `/orders/${order.id}/collect`, { payment: { amount: expected, method: 'cash', idempotency_key: payKey } });
  assert.equal(r.body.duplicate, true);
  const custFinal = await one('select balance from customers where id = $1', [cust.id]);
  assert.equal(custFinal.balance, cust.balance);
  const ledgerSum = await one('select sum(amount) s from customer_ledger where customer_id = $1', [cust.id]);
  assert.equal(ledgerSum.s, custFinal.balance);
  // Customer sees own invoice, not others'.
  assert.equal((await api('ramesh', 'GET', `/invoices/${order.invoice.id}`)).status, 200);
  assert.equal((await api('fatima', 'GET', `/invoices/${order.invoice.id}`)).status, 404);
});

test('photo and voice orders store the file privately and ask a question in mock mode', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
  let form = new FormData();
  form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'list.jpg');
  let r = await api('fatima', 'POST', '/orders/parse', null, { form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const photo = r.body.order;
  assert.equal(photo.channel, 'photo');
  assert.equal(photo.status, 'needs_clarification');
  assert.ok(photo.has_file);
  const f = await api('fatima', 'GET', `/orders/${photo.id}/file`);
  assert.equal(f.status, 200);
  assert.equal((await api('ramesh', 'GET', `/orders/${photo.id}/file`)).status, 404);

  // Answering the free-text question on an empty order reads the answer as items (feature 1, decision 4).
  const q = photo.clarifications[0];
  r = await api('fatima', 'POST', `/orders/${photo.id}/clarifications/${q.id}/answer`, { text: '1 atta 5kg' });
  assert.equal(r.body.order.status, 'draft');
  assert.deepEqual(r.body.order.items.map((i) => [i.sku, i.quantity]), [['ATTA-5KG', 1]]);
  // An answer with no recognisable items is refused and nothing changes.
  form = new FormData();
  form.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'list2.jpg');
  const photo2 = (await api('fatima', 'POST', '/orders/parse', null, { form })).body.order;
  r = await api('fatima', 'POST', `/orders/${photo2.id}/clarifications/${photo2.clarifications[0].id}/answer`, { text: '.' }); // nothing the parser can read
  assert.equal(r.status, 400);
  assert.equal((await api('fatima', 'GET', `/orders/${photo2.id}`)).body.order.status, 'needs_clarification');
  await api('fatima', 'POST', `/orders/${photo2.id}/cancel`, {});
  r = await api('fatima', 'POST', `/orders/${photo.id}/cancel`, {});
  assert.equal(r.body.order.status, 'cancelled');

  // Voice note (codec parameter in mimetype is normalised).
  form = new FormData();
  form.set('file', new Blob([Buffer.alloc(300, 1)], { type: 'audio/webm;codecs=opus' }), 'note.webm');
  r = await api('fatima', 'POST', '/orders/parse', null, { form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.channel, 'voice');

  // Fake image bytes are rejected; disallowed types are rejected; nothing is written.
  const before = await one('select count(*)::int n from orders');
  form = new FormData(); form.set('file', new Blob([Buffer.from('hello')], { type: 'image/png' }), 'x.png');
  assert.equal((await api('fatima', 'POST', '/orders/parse', null, { form })).status, 400);
  form = new FormData(); form.set('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'x.exe');
  assert.equal((await api('fatima', 'POST', '/orders/parse', null, { form })).status, 400);
  assert.equal((await one('select count(*)::int n from orders')).n, before.n);

  // Every parse is logged: the photo itself, and the typed answer that was read as items.
  const ev = await one(`select count(*)::int n from ai_events where kind = 'parse_order' and order_id = $1`, [photo.id]);
  assert.equal(ev.n, 2);
});

test('counter mode: staff orders for a customer; customers cannot order for others', async () => {
  const walkin = await one(`select id from customers where phone = '9000000199'`);
  const form = new FormData(); form.set('text', '1 sunflower oil'); form.set('customer_id', walkin.id);
  let r = await api('staff', 'POST', '/orders/parse', null, { form });
  assert.equal(r.status, 201); assert.equal(r.body.order.customer.id, walkin.id);
  const f2 = new FormData(); f2.set('text', '1 sunflower oil'); f2.set('customer_id', walkin.id);
  assert.equal((await api('ramesh', 'POST', '/orders/parse', null, { form: f2 })).status, 403);
  // Staff must pick a customer.
  const f3 = new FormData(); f3.set('text', '1 sunflower oil');
  assert.equal((await api('staff', 'POST', '/orders/parse', null, { form: f3 })).status, 400);
  // Manual counter order with SKUs.
  r = await api('staff', 'POST', '/orders', { customer_id: walkin.id, items: [{ sku: 'SALT-1KG', quantity: 2 }] });
  assert.equal(r.status, 201); assert.equal(r.body.order.channel, 'counter');
  // Cannot finish packing more stock than exists.
  const cust = await one(`select id from customers where phone='9000000199'`);
  const ghee = await one(`select stock_qty from products where sku='GHEE-500ML'`);
  r = await api('staff', 'POST', '/orders', { customer_id: cust.id, items: [{ sku: 'GHEE-500ML', quantity: ghee.stock_qty + 5 }] });
  const id = r.body.order.id;
  await api('staff', 'POST', `/orders/${id}/submit`);
  await api('staff', 'POST', `/orders/${id}/approve`, {});
  await api('staff', 'POST', `/orders/${id}/start-picking`);
  r = await api('staff', 'POST', `/orders/${id}/finish-packing`, { pack_remaining: true });
  assert.equal(r.status, 409);
  assert.equal((await one(`select stock_qty from products where sku='GHEE-500ML'`)).stock_qty, ghee.stock_qty);
  assert.equal((await one('select count(*)::int n from invoices where order_id = $1', [id])).n, 0);
  assert.equal((await one('select status from orders where id = $1', [id])).status, 'picking');
});
