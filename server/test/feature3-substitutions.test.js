// Integration test for Feature 3: Smart substitutions (candidates, unit conversion,
// accept/decline, out-of-stock & authorization guards, proceed_without_substitutes, stock/ledger).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
const TAG = Date.now().toString(36).toUpperCase();
const SKU_10 = `T${TAG}-DAL-10`;
const SKU_5 = `T${TAG}-DAL-5`;
const SKU_2 = `T${TAG}-DAL-2`;
const SKU_1 = `T${TAG}-DAL-1`;
const SKU_NOGROUP = `T${TAG}-NOGROUP`;
let server; let base; const tok = {};
const createdProductIds = [];
const createdOrderIds = [];

async function api(who, method, path, body) {
  const headers = {};
  if (tok[who]) headers.authorization = `Bearer ${tok[who]}`;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

before(async () => {
  assert.ok(config.gemini.mock, 'Tests expect Gemini mock mode.');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['owner', '9000000001'], ['staff', '9000000002'], ['ramesh', '9000000101'], ['fatima', '9000000102']]) {
    const r = await api(null, 'POST', '/auth/login', { phone, password: PASSWORD });
    assert.equal(r.status, 200, `login ${who}`);
    tok[who] = r.body.token;
  }

  const prods = [
    { sku: SKU_10, name: 'Test Dal 10 kg', category: 'Pulses', unit: 'kg', pack_size: 10, price: 1100, opening_stock: 20, substitute_group: `tdal-${TAG}` },
    { sku: SKU_5, name: 'Test Dal 5 kg', category: 'Pulses', unit: 'kg', pack_size: 5, price: 560, opening_stock: 20, substitute_group: `tdal-${TAG}` },
    { sku: SKU_2, name: 'Test Dal 2 kg', category: 'Pulses', unit: 'kg', pack_size: 2, price: 240, opening_stock: 20, substitute_group: `tdal-${TAG}` },
    { sku: SKU_1, name: 'Test Dal 1 kg', category: 'Pulses', unit: 'kg', pack_size: 1, price: 140, opening_stock: 20, substitute_group: `tdal-${TAG}` },
    { sku: SKU_NOGROUP, name: 'Test Unrelated 1 kg', category: 'Pulses', unit: 'kg', pack_size: 1, price: 90, opening_stock: 10, substitute_group: null },
  ];
  for (const p of prods) {
    const res = await api('owner', 'POST', '/products', p);
    assert.equal(res.status, 201, `create ${p.sku}: ${JSON.stringify(res.body)}`);
    createdProductIds.push(res.body.product.id);
  }
});

after(async () => {
  if (createdOrderIds.length) {
    await pool.query('delete from invoices where order_id = any($1)', [createdOrderIds]);
    await pool.query('delete from orders where id = any($1)', [createdOrderIds]);
  }
  if (createdProductIds.length) {
    await pool.query(`delete from stock_movements where product_id = any($1)`, [createdProductIds]);
    await pool.query(`delete from products where id = any($1)`, [createdProductIds]);
  }
  server.close();
  await pool.end();
});

test('Feature 3: full substitution flow (unit conversion, accept, stock/ledger invariance, invoice substitutes_sku)', async () => {
  const ramesh = await one(`select id, balance from customers where phone = '9000000101'`);
  const dal5Before = await one(`select * from products where sku = $1`, [SKU_5]);
  const dal10Before = await one(`select * from products where sku = $1`, [SKU_10]);

  const draft = await api('staff', 'POST', '/orders', {
    customer_id: ramesh.id,
    items: [
      { sku: SKU_10, quantity: 1 },
      { sku: SKU_NOGROUP, quantity: 1 },
    ],
    idempotency_key: randomUUID(),
  });
  assert.equal(draft.status, 201);
  const oid = draft.body.order.id;
  createdOrderIds.push(oid);

  assert.equal((await api('staff', 'POST', `/orders/${oid}/submit`)).status, 200);
  assert.equal((await api('staff', 'POST', `/orders/${oid}/approve`, {})).status, 200);
  const pick = await api('staff', 'POST', `/orders/${oid}/start-picking`);
  assert.equal(pick.status, 200);

  const origDal = pick.body.order.items.find((i) => i.sku === SKU_10);
  const origNoGroup = pick.body.order.items.find((i) => i.sku === SKU_NOGROUP);

  // Product without substitute_group produces 0 suggestions.
  const markNoGrp = await api('staff', 'PATCH', `/orders/${oid}/items/${origNoGroup.id}/pick`, { pick_status: 'unavailable' });
  assert.equal(markNoGrp.status, 200);
  assert.equal(markNoGrp.body.order.substitutions.length, 0);

  // Marking 1 × 10kg dal unavailable offers max 2 substitutes (with 2 × 5kg first!).
  const markDal = await api('staff', 'PATCH', `/orders/${oid}/items/${origDal.id}/pick`, { pick_status: 'unavailable' });
  assert.equal(markDal.status, 200);
  const subs = markDal.body.order.substitutions;
  assert.equal(subs.length, 2, 'Capped at 2 suggestions');
  assert.ok(subs.every((s) => s.status === 'pending'));
  const sub5 = subs.find((s) => s.product_sku === SKU_5);
  assert.ok(sub5, '5kg pack offered');
  assert.equal(sub5.quantity, 2, '1 × 10kg shortfall converts to 2 × 5kg');

  // Pick queue exposes pending_substitutions >= 1.
  const qRes = await api('staff', 'GET', '/orders/pick-queue');
  const qItem = qRes.body.queue.find((q) => q.id === oid);
  assert.equal(qItem.pending_substitutions, 2);

  // Finish packing blocks with 409 while offers remain pending.
  const blocked = await api('staff', 'POST', `/orders/${oid}/finish-packing`, { pack_remaining: true });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.pending_substitutions.length, 2);

  // Customer isolation: Fatima cannot accept Ramesh's substitution.
  assert.equal((await api('fatima', 'POST', `/orders/${oid}/substitutions/${sub5.id}/accept`)).status, 404);

  // Out-of-stock guard: temporarily set 5kg stock to 1 -> accept fails 409 -> restore to 20.
  await pool.query(`update products set stock_qty = 1 where id = $1`, [dal5Before.id]);
  const oos = await api('ramesh', 'POST', `/orders/${oid}/substitutions/${sub5.id}/accept`);
  assert.equal(oos.status, 409);
  await pool.query(`update products set stock_qty = $2 where id = $1`, [dal5Before.id, dal5Before.stock_qty]);

  // Ramesh accepts 2 × 5kg -> adds substitute item & expires peer suggestion.
  const acc = await api('ramesh', 'POST', `/orders/${oid}/substitutions/${sub5.id}/accept`);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.duplicate, false);
  const afterAcc = acc.body.order;
  const subOrderItem = afterAcc.items.find((i) => i.origin === 'substitution' && i.sku === SKU_5);
  assert.ok(subOrderItem);
  assert.equal(subOrderItem.quantity, 2);
  assert.equal(subOrderItem.substitutes_item_id, origDal.id);
  assert.equal(subOrderItem.substitutes_sku, SKU_10);
  const peer = afterAcc.substitutions.find((s) => s.id !== sub5.id);
  assert.equal(peer.status, 'expired');

  // Idempotent repeat accept returns duplicate: true.
  const accDup = await api('ramesh', 'POST', `/orders/${oid}/substitutions/${sub5.id}/accept`);
  assert.equal(accDup.status, 200);
  assert.equal(accDup.body.duplicate, true);

  // Cannot switch original item back to fully 'packed' or 'pending' once substitute is accepted.
  assert.equal((await api('staff', 'PATCH', `/orders/${oid}/items/${origDal.id}/pick`, { pick_status: 'packed' })).status, 409);
  assert.equal((await api('staff', 'PATCH', `/orders/${oid}/items/${origDal.id}/pick`, { pick_status: 'pending' })).status, 409);

  // Staff marks substitute item packed and finishes packing.
  assert.equal((await api('staff', 'PATCH', `/orders/${oid}/items/${subOrderItem.id}/pick`, { pick_status: 'packed' })).status, 200);
  const fin = await api('staff', 'POST', `/orders/${oid}/finish-packing`, {});
  assert.equal(fin.status, 200);
  const ready = fin.body.order;
  assert.equal(ready.status, 'ready');

  const expectedTotal = 2 * Number(dal5Before.price);
  assert.equal(ready.invoice.total, expectedTotal);

  const invRes = await api('ramesh', 'GET', `/invoices/${ready.invoice.id}`);
  assert.equal(invRes.status, 200);
  assert.equal(invRes.body.invoice.lines.length, 1);
  assert.equal(invRes.body.invoice.lines[0].sku, SKU_5);
  assert.equal(invRes.body.invoice.lines[0].substitutes_sku, SKU_10);

  // Exact stock & balance invariants.
  const dal5After = await one(`select stock_qty from products where id = $1`, [dal5Before.id]);
  const dal10After = await one(`select stock_qty from products where id = $1`, [dal10Before.id]);
  assert.equal(dal5After.stock_qty, dal5Before.stock_qty - 2);
  assert.equal(dal10After.stock_qty, dal10Before.stock_qty);
  const custAfter = await one(`select balance from customers where id = $1`, [ramesh.id]);
  assert.equal(custAfter.balance, Math.round((ramesh.balance + expectedTotal) * 100) / 100);

  const pay = await api('staff', 'POST', `/orders/${oid}/collect`, {
    payment: { amount: expectedTotal, method: 'cash', idempotency_key: randomUUID() },
  });
  assert.equal(pay.status, 200);
});

test('Feature 3: decline & proceed_without_substitutes fallback', async () => {
  const fatima = await one(`select id from customers where phone = '9000000102'`);
  const draft = await api('staff', 'POST', '/orders', {
    customer_id: fatima.id,
    items: [{ sku: SKU_10, quantity: 1 }, { sku: 'SALT-1KG', quantity: 1 }],
    idempotency_key: randomUUID(),
  });
  assert.equal(draft.status, 201);
  const oid = draft.body.order.id;
  createdOrderIds.push(oid);
  await api('staff', 'POST', `/orders/${oid}/submit`);
  await api('staff', 'POST', `/orders/${oid}/approve`, {});
  await api('staff', 'POST', `/orders/${oid}/start-picking`);

  const ord = (await api('staff', 'GET', `/orders/${oid}`)).body.order;
  const item = ord.items.find((i) => i.sku === SKU_10);
  const m = await api('staff', 'PATCH', `/orders/${oid}/items/${item.id}/pick`, { pick_status: 'unavailable' });
  const subs = m.body.order.substitutions;
  assert.equal(subs.length, 2);

  // Decline first offer -> second remains pending.
  const dec = await api('fatima', 'POST', `/orders/${oid}/substitutions/${subs[0].id}/decline`);
  assert.equal(dec.status, 200);
  assert.equal(dec.body.order.substitutions.find((s) => s.id === subs[0].id).status, 'declined');

  // proceed_without_substitutes: true expires the remaining pending offer and packs the remaining Salt item.
  const fin = await api('staff', 'POST', `/orders/${oid}/finish-packing`, { pack_remaining: true, proceed_without_substitutes: true });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.order.status, 'ready');
  assert.equal(fin.body.order.substitutions.find((s) => s.id === subs[1].id).status, 'expired');

  // Collect so Fatima's ₹0 balance remains untouched for downstream tests.
  const col = await api('staff', 'POST', `/orders/${oid}/collect`, {
    payment: { amount: fin.body.order.invoice.total, method: 'cash', idempotency_key: randomUUID() },
  });
  assert.equal(col.status, 200);
});
