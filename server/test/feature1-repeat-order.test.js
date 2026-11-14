// Feature 1: "same as last time" orders. Mock Gemini (npm test), local database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { buildDraft, NO_PREVIOUS_ORDER_QUESTION } from '../src/services/orders.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
let server; let base; const tok = {}; const created = [];

async function api(who, method, path, body, form) {
  const headers = { authorization: `Bearer ${tok[who]}` };
  let payload = form;
  if (!form && body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}
async function parse(who, text, customerId) {
  const fd = new FormData(); fd.set('text', text); if (customerId) fd.set('customer_id', customerId);
  const r = await api(who, 'POST', '/orders/parse', undefined, fd);
  if (r.body.order) created.push([who, r.body.order.id]);
  return r;
}
/** Same rule as the server: latest collected/ready order, matched lines, no substitutes. */
async function previousOf(phone) {
  const o = (await pool.query(
    `select o.id, o.order_no from orders o join customers c on c.id = o.customer_id
     where c.phone = $1 and o.status in ('collected','ready') order by o.created_at desc limit 1`, [phone])).rows[0];
  if (!o) return null;
  const items = (await pool.query(
    `select sku, quantity from order_items where order_id = $1 and product_id is not null and coalesce(origin,'') <> 'substitution'`, [o.id])).rows;
  return { ...o, items: new Map(items.map((i) => [i.sku, Number(i.quantity)])) };
}
const lines = (order) => new Map(order.items.map((i) => [i.sku, { q: Number(i.quantity), origin: i.origin }]));

before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['owner', '9000000001'], ['staff', '9000000002'], ['ramesh', '9000000101'], ['anita', '9000000103']]) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password: PASSWORD }) });
    tok[who] = (await r.json()).token;
  }
});
after(async () => {
  for (const [who, id] of created) await api(who, 'POST', `/orders/${id}/cancel`, {}).catch(() => {});
  server.close(); await pool.end();
});

test('"usual order plus 2 <new item>": previous lines copied and tagged, new line added, linked to the previous order', async () => {
  const prev = await previousOf('9000000101');
  assert.ok(prev, 'fixture: Ramesh has a previous order');
  const [extra, word] = [['SALT-1KG', 'salt'], ['RAVA-1KG', 'rava'], ['POHA-500G', 'poha']].find(([sku]) => !prev.items.has(sku));
  const { status, body } = await parse('ramesh', `usual order plus 2 ${word}`);
  assert.equal(status, 201);
  const o = body.order; const l = lines(o);
  assert.equal(o.status, 'draft');
  assert.equal(o.based_on.id, prev.id);
  assert.equal(o.based_on.order_no, prev.order_no);
  for (const [sku, q] of prev.items) assert.deepEqual(l.get(sku), { q, origin: 'previous_order' }, sku);
  assert.deepEqual(l.get(extra), { q: 2, origin: 'parsed' });
  assert.equal(o.items.length, prev.items.size + 1);
});

test('"same as last time plus 2 sugar": one sugar line with the combined quantity', async () => {
  const prev = await previousOf('9000000101');
  const { body } = await parse('ramesh', 'same as last time plus 2 sugar');
  const sugar = body.order.items.filter((i) => i.sku === 'SUGAR-1KG');
  assert.equal(sugar.length, 1, 'never the same SKU twice');
  assert.equal(Number(sugar[0].quantity), (prev.items.get('SUGAR-1KG') || 0) + 2);
});

test('"usual without <item>" removes that line', async () => {
  const prev = await previousOf('9000000101');
  const [dropSku] = prev.items.keys();
  const alias = (await pool.query('select aliases[1] a from products where sku = $1', [dropSku])).rows[0].a;
  const { body } = await parse('ramesh', `my usual, without ${alias}`);
  const l = lines(body.order);
  assert.equal(l.has(dropSku), false);
  assert.equal(l.size, prev.items.size - 1);
});

test('a plain order does not pull in the previous order', async () => {
  const { body } = await parse('ramesh', '2 kg sugar');
  assert.equal(body.order.based_on, null);
  assert.deepEqual([...lines(body.order)], [['SUGAR-1KG', { q: 2, origin: 'parsed' }]]);
});

test('last order still "ready" counts as the previous order', async () => {
  const prev = await previousOf('9000000103');
  assert.ok(prev, 'fixture: Anita has a ready/collected order');
  const { body } = await parse('anita', 'same again');
  assert.equal(body.order.based_on.id, prev.id);
  assert.equal(body.order.items.length, prev.items.size);
});

test('no previous order (counter mode): asks instead of guessing, then reads the answer as items', async () => {
  const walkin = (await pool.query(`select id from customers where phone = '9000000199'`)).rows[0];
  assert.equal(await previousOf('9000000199'), null, 'fixture: walk-in has no collected/ready order');
  const { status, body } = await parse('staff', 'usual order', walkin.id);
  assert.equal(status, 201);
  const o = body.order;
  assert.equal(o.status, 'needs_clarification');
  assert.equal(o.items.length, 0);
  assert.equal(o.based_on, null);
  const q = o.clarifications.find((c) => !c.answered_at);
  assert.equal(q.question, NO_PREVIOUS_ORDER_QUESTION);

  const r = await api('staff', 'POST', `/orders/${o.id}/clarifications/${q.id}/answer`, { text: '2 kg sugar, 1 toor dal' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'draft');
  assert.deepEqual([...lines(r.body.order)].sort(), [['SUGAR-1KG', { q: 2, origin: 'parsed' }], ['TOOR-1KG', { q: 1, origin: 'parsed' }]]);
});

test('a previous item that is no longer sold becomes a question, not a silent copy', async () => {
  const prev = await previousOf('9000000101');
  const [sku] = prev.items.keys();
  const p = (await pool.query('select id from products where sku = $1', [sku])).rows[0];
  await api('owner', 'PATCH', `/products/${p.id}`, { active: false });
  try {
    const { body } = await parse('ramesh', 'usual order');
    assert.equal(body.order.status, 'needs_clarification');
    const item = body.order.items.find((i) => i.sku === null && i.origin === 'previous_order');
    assert.ok(item, 'unavailable previous line kept as an unmatched line');
    const q = body.order.clarifications.find((c) => c.item_id === item.id);
    assert.match(q.question, /from your last order is not available/);
  } finally {
    await api('owner', 'PATCH', `/products/${p.id}`, { active: true });
  }
});

test('buildDraft: the model cannot mark an item "from previous" unless it really was in that order; duplicates merge', () => {
  const catalog = [{ id: 'a', sku: 'SUGAR-1KG', name: 'Sugar 1 kg', unit: 'kg', pack_size: 1, price: 48 },
    { id: 'b', sku: 'SALT-1KG', name: 'Salt 1 kg', unit: 'kg', pack_size: 1, price: 28 }];
  const prev = { id: 'prev', items: [{ sku: 'SUGAR-1KG', quantity: 3 }] };
  const item = (sku, quantity, from_previous) => ({ sku, name: sku, quantity, unit: null, confidence: 'high', candidates: [], from_previous });
  const d = buildDraft({ items: [item('SUGAR-1KG', 3, true), item('SALT-1KG', 1, true), item('SUGAR-1KG', 2, false)], questions: [], refers_to_previous: true }, catalog, prev);
  assert.deepEqual(d.items.map((i) => [i.product.sku, i.quantity, i.origin]), [['SUGAR-1KG', 5, 'previous_order'], ['SALT-1KG', 1, 'parsed']]);
  assert.equal(d.basedOnOrderId, 'prev');
  const none = buildDraft({ items: [], questions: [], refers_to_previous: true }, catalog, null);
  assert.equal(none.basedOnOrderId, null);
  assert.deepEqual(none.general.map((g) => g.question), [NO_PREVIOUS_ORDER_QUESTION]);
});
