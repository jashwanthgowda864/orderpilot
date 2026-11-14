// Integration & unit tests for Features 2 (source trail), 5 (ready-time),
// 7 (proactive reorder nudges), and 8 (payment reminder drafts) in Gemini mock mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { calculateReadyMinutes } from '../src/services/readyTime.js';
import { median } from '../src/services/reorder.js';
import { isSafeReminderText } from '../src/services/reminders.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
let server; let base; const tok = {};
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
  for (const [who, phone] of [
    ['owner', '9000000001'],
    ['staff', '9000000002'],
    ['ramesh', '9000000101'],
    ['fatima', '9000000102'],
    ['anita', '9000000103'],
  ]) {
    const r = await api(null, 'POST', '/auth/login', { phone, password: PASSWORD });
    assert.equal(r.status, 200, `login ${who}`);
    tok[who] = r.body.token;
  }
});

after(async () => {
  if (createdOrderIds.length) {
    await pool.query('delete from invoices where order_id = any($1)', [createdOrderIds]);
    await pool.query('delete from orders where id = any($1)', [createdOrderIds]);
  }
  server.close();
  await pool.end();
});

test('Feature 2: source_text stored from text order and updated properly on draft review', async () => {
  const form = new FormData();
  form.set('text', '2 kg sugar\n1 kg toor dal');
  form.set('idempotency_key', randomUUID());
  const headers = { authorization: `Bearer ${tok.ramesh}` };
  const rawRes = await fetch(`${base}/orders/parse`, { method: 'POST', headers, body: form });
  const res = { status: rawRes.status, body: await rawRes.json() };
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const order = res.body.order;
  createdOrderIds.push(order.id);
  assert.equal(order.status, 'draft');
  assert.ok(order.items.length >= 2);
  const sugar = order.items.find((i) => i.sku === 'SUGAR-1KG');
  const dal = order.items.find((i) => i.sku === 'TOOR-1KG');
  assert.ok(sugar && sugar.source_text, 'sugar has source_text');
  assert.ok(dal && dal.source_text, 'dal has source_text');

  // Review edit: same SKU keeps source_text; swapped SKU becomes manual with cleared confidence;
  // new item has origin manual & null source_text.
  const put = await api('ramesh', 'PUT', `/orders/${order.id}/items`, {
    items: [
      { id: sugar.id, sku: 'SUGAR-1KG', quantity: 3 },
      { id: dal.id, sku: 'SALT-1KG', quantity: 1 },
      { sku: 'TEA-250G', quantity: 1 },
    ],
  });
  assert.equal(put.status, 200);
  const edited = put.body.order.items;
  const sAfter = edited.find((i) => i.sku === 'SUGAR-1KG');
  const saltAfter = edited.find((i) => i.sku === 'SALT-1KG');
  const teaAfter = edited.find((i) => i.sku === 'TEA-250G');

  assert.equal(sAfter.source_text, sugar.source_text);
  assert.equal(sAfter.origin, sugar.origin);
  assert.equal(saltAfter.confidence, null);
  assert.equal(saltAfter.origin, 'manual');
  assert.equal(teaAfter.origin, 'manual');
  assert.equal(teaAfter.source_text, null);
});

test('Feature 5: calculateReadyMinutes formula & queue lifecycle updates', async () => {
  // Unit assertions against config defaults (setup=3, perLine=1, pickers=1).
  assert.equal(calculateReadyMinutes({ ownLines: 0 }), 5);
  assert.equal(calculateReadyMinutes({ ownLines: 1 }), 5);  // 3 + 1 = 4 -> ceil5 = 5
  assert.equal(calculateReadyMinutes({ ownLines: 5, aheadLines: 4, aheadApprovedCount: 1 }), 15); // 3 + 5 + 4 + 3 = 15

  // End-to-end two orders entering queue.
  const rameshCust = await one(`select id from customers where phone = '9000000101'`);
  const makeForRamesh = async (items) => {
    const r = await api('staff', 'POST', '/orders', {
      customer_id: rameshCust.id, items, idempotency_key: randomUUID(),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    createdOrderIds.push(r.body.order.id);
    assert.equal((await api('staff', 'POST', `/orders/${r.body.order.id}/submit`)).status, 200);
    return r.body.order.id;
  };

  const idA = await makeForRamesh([{ sku: 'SALT-1KG', quantity: 1 }]);
  const idB = await makeForRamesh([{ sku: 'SALT-1KG', quantity: 1 }, { sku: 'TEA-250G', quantity: 1 }]);

  const appA = await api('staff', 'POST', `/orders/${idA}/approve`, {});
  assert.equal(appA.status, 200);
  assert.ok(appA.body.order.ready_estimate_minutes >= 5);
  assert.ok(appA.body.order.ready_estimate_at);

  const appB = await api('staff', 'POST', `/orders/${idB}/approve`, {});
  assert.equal(appB.status, 200);
  assert.ok(appB.body.order.ready_estimate_minutes > appA.body.order.ready_estimate_minutes,
    'Order B queued behind A has longer ready estimate');

  // Start picking A -> A's estimate uses own unpicked lines; check pick-queue exposes estimate.
  const pickA = await api('staff', 'POST', `/orders/${idA}/start-picking`);
  assert.equal(pickA.status, 200);
  assert.equal(pickA.body.order.ready_estimate_minutes, calculateReadyMinutes({ ownLines: 1 }));
  const pq = await api('staff', 'GET', '/orders/pick-queue');
  const qEntry = pq.body.queue.find((q) => q.id === idA);
  assert.ok(qEntry && qEntry.ready_estimate_minutes != null);

  // Cancel B -> clears B's estimate.
  const cancelB = await api('staff', 'POST', `/orders/${idB}/cancel`, { reason: 'test' });
  assert.equal(cancelB.status, 200);
  assert.equal(cancelB.body.order.ready_estimate_minutes, null);
  assert.equal(cancelB.body.order.ready_estimate_at, null);

  // Finish packing A -> clears A's estimate; collect invoice to keep seeded balance unchanged.
  const finA = await api('staff', 'POST', `/orders/${idA}/finish-packing`, { pack_remaining: true, proceed_without_substitutes: true });
  assert.equal(finA.status, 200);
  assert.equal(finA.body.order.ready_estimate_minutes, null);
  const colA = await api('staff', 'POST', `/orders/${idA}/collect`, {
    payment: { amount: finA.body.order.invoice.total, method: 'cash', idempotency_key: randomUUID() },
  });
  assert.equal(colA.status, 200);
});

test('Feature 7: median, suggestions, nudge draft idempotency, dismiss, and owner /due', async () => {
  assert.equal(median([]), 0);
  assert.equal(median([10]), 10);
  assert.equal(median([7, 14]), 10.5);
  assert.equal(median([1, 10, 7]), 7);

  // Owner sees due customers; customer & staff get 403.
  assert.equal((await api('ramesh', 'GET', '/reorder/due')).status, 403);
  assert.equal((await api('staff', 'GET', '/reorder/due')).status, 403);
  const dueRes = await api('owner', 'GET', '/reorder/due');
  assert.equal(dueRes.status, 200);
  assert.ok(Array.isArray(dueRes.body.due) && dueRes.body.due.length >= 1, 'Seeded due customers present');

  const sugRes = await api('ramesh', 'GET', '/reorder/suggestions');
  assert.equal(sugRes.status, 200);
  assert.ok(sugRes.body.suggestions.length >= 1, 'Ramesh has due suggestions');
  const first = sugRes.body.suggestions[0];
  assert.ok(first.suggested_quantity > 0);
  assert.ok(first.order_count >= 3);

  // Creating a nudge draft is idempotent and suppresses the item from open suggestions.
  const ikey = randomUUID();
  const d1 = await api('ramesh', 'POST', '/reorder/draft', {
    items: [{ sku: first.sku, quantity: first.suggested_quantity }],
    idempotency_key: ikey,
  });
  assert.equal(d1.status, 201);
  assert.equal(d1.body.duplicate, false);
  createdOrderIds.push(d1.body.order.id);
  assert.equal(d1.body.order.channel, 'nudge');
  assert.equal(d1.body.order.status, 'draft');
  assert.equal(d1.body.order.items[0].origin, 'previous_order');

  const d2 = await api('ramesh', 'POST', '/reorder/draft', {
    items: [{ sku: first.sku, quantity: first.suggested_quantity }],
    idempotency_key: ikey,
  });
  assert.equal(d2.status, 200);
  assert.equal(d2.body.duplicate, true);
  assert.equal(d2.body.order.id, d1.body.order.id);

  const afterDraft = await api('ramesh', 'GET', '/reorder/suggestions');
  assert.ok(!afterDraft.body.suggestions.some((s) => s.product_id === first.product_id),
    'Item in open draft is hidden from suggestions');

  // Dismissing a second suggestion hides it until next order.
  const second = afterDraft.body.suggestions[0];
  if (second) {
    assert.equal((await api('ramesh', 'POST', '/reorder/dismiss', { product_id: second.product_id })).status, 200);
    const afterDismiss = await api('ramesh', 'GET', '/reorder/suggestions');
    assert.ok(!afterDismiss.body.suggestions.some((s) => s.product_id === second.product_id));
    await pool.query('delete from reorder_nudge_dismissals where product_id = $1', [second.product_id]);
  }
});

test('Feature 8: isSafeReminderText guard and POST /reminders/draft language priority + 409 zero balance', async () => {
  const lp = new Date('2026-11-07T10:00:00Z');
  assert.equal(isSafeReminderText('Hello from Shop! Balance is ₹998, last paid 07 Nov 2026.', { amount: 998, lastPaymentAt: lp }), true);
  assert.equal(isSafeReminderText('Hello! Balance ₹998 + ₹50 fee.', { amount: 998, lastPaymentAt: lp }), false);
  assert.equal(isSafeReminderText('Pay ₹998 at https://evil.example', { amount: 998, lastPaymentAt: lp }), false);
  assert.equal(isSafeReminderText('Pay ₹998 contact @user', { amount: 998, lastPaymentAt: lp }), false);
  assert.equal(isSafeReminderText('Please pay soon.', { amount: 998, lastPaymentAt: lp }), false);

  const ramesh = await one(`select id from customers where phone = '9000000101'`);
  const fatima = await one(`select id from customers where phone = '9000000102'`);
  const anita = await one(`select id from customers where phone = '9000000103'`);

  // Role check: customer & staff blocked.
  assert.equal((await api('staff', 'POST', '/reminders/draft', { customer_id: ramesh.id })).status, 403);
  assert.equal((await api('ramesh', 'POST', '/reminders/draft', { customer_id: ramesh.id })).status, 403);

  // Fatima has ₹0 balance -> 409.
  assert.equal((await api('owner', 'POST', '/reminders/draft', { customer_id: fatima.id })).status, 409);

  // Ramesh prefers Kannada ('kn').
  const remR = await api('owner', 'POST', '/reminders/draft', { customer_id: ramesh.id });
  assert.equal(remR.status, 200);
  assert.equal(remR.body.language, 'kn');
  assert.equal(remR.body.amount, 998);
  assert.ok(remR.body.text.includes('998'));

  // Anita has null preferred_language -> falls back to latest order language ('en').
  const remA = await api('owner', 'POST', '/reminders/draft', { customer_id: anita.id });
  assert.equal(remA.status, 200);
  assert.equal(remA.body.language, 'en');
  assert.ok(remA.body.text.includes('1,142') || remA.body.text.includes('1142'));

  // Shop setting substitution_wait_minutes exposed in GET /settings/shop.
  const shopRes = await api('staff', 'GET', '/settings/shop');
  assert.equal(shopRes.status, 200);
  assert.equal(typeof shopRes.body.substitution_wait_minutes, 'number');
});
