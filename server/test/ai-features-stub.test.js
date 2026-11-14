// AI-stubbed (GEMINI_MOCK=0) tests for Features 2, 3, 4, 6, 8 using stubbed Google fetch.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.GEMINI_MOCK = '0';
process.env.GEMINI_API_KEY = 'test-key-not-real';
process.env.GEMINI_MODEL = 'main-model';
process.env.GEMINI_FALLBACK_MODEL = 'lite-model';
process.env.GEMINI_TIMEOUT_MS = '150';
process.env.GEMINI_FALLBACK_TIMEOUT_MS = '150';
process.env.GEMINI_BACKOFF_MS = '5';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { readdir } = await import('node:fs/promises');

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
const TAG = Date.now().toString(36).toUpperCase();
const createdOrderIds = [];
const createdBillIds = [];
const createdProductIds = [];

let queue = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, init);
  const item = queue.shift();
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (typeof item === 'number') return json(item, { error: { code: item, message: 'simulated' } });
  if (item === 'timeout') {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }
  return json(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(item) }] } }] });
};

let server; let base; const tok = {};
async function api(who, method, path, body, { form } = {}) {
  const headers = {};
  if (tok[who]) headers.authorization = `Bearer ${tok[who]}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const countBillFiles = async () => (await readdir(`${config.storage.localDir}/supplier-bills`, { recursive: true }).catch(() => [])).filter((f) => /\.(png|jpg|webp|heic)$/.test(f)).length;

before(async () => {
  assert.equal(config.gemini.mock, false);
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['owner', '9000000001'], ['staff', '9000000002'], ['ramesh', '9000000101']]) {
    const r = await api(null, 'POST', '/auth/login', { phone, password: PASSWORD });
    assert.equal(r.status, 200);
    tok[who] = r.body.token;
  }
});

beforeEach(() => { queue = []; });

after(async () => {
  if (createdOrderIds.length) {
    await pool.query('delete from invoices where order_id = any($1)', [createdOrderIds]);
    await pool.query('delete from orders where id = any($1)', [createdOrderIds]);
  }
  if (createdProductIds.length) {
    await pool.query('delete from stock_movements where product_id = any($1)', [createdProductIds]);
    await pool.query('delete from products where id = any($1)', [createdProductIds]);
  }
  if (createdBillIds.length) {
    await pool.query('delete from supplier_bills where id = any($1)', [createdBillIds]);
  }
  server.close();
  await pool.end();
});

test('AI stub Feature 2: preserves source_text and tolerates missing/oversized source_text', async () => {
  queue.push({
    language: 'en',
    transcript: null,
    refers_to_previous: false,
    items: [
      { sku: 'SUGAR-1KG', name: 'sugar', quantity: 2, unit: 'kg', confidence: 'high', source_text: '2kg chini', from_previous: false, candidates: [] },
      { sku: 'TOOR-1KG', name: 'toor dal', quantity: 1, unit: 'kg', confidence: 'medium', source_text: 'x'.repeat(450), from_previous: false, candidates: [] },
    ],
    questions: [],
  });

  const form = new FormData();
  form.set('text', '2kg chini and toor dal');
  form.set('idempotency_key', randomUUID());
  const res = await api('ramesh', 'POST', '/orders/parse', undefined, { form });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  createdOrderIds.push(res.body.order.id);
  const sugar = res.body.order.items.find((i) => i.sku === 'SUGAR-1KG');
  const dal = res.body.order.items.find((i) => i.sku === 'TOOR-1KG');
  assert.equal(sugar.source_text, '2kg chini');
  assert.equal(dal.source_text, null, 'Oversized source_text gracefully caught to null');
});

test('AI stub Feature 3: >2 candidates triggers AI tie-breaker; AI failure falls back cleanly', async () => {
  const prods = [
    { sku: `A${TAG}-10`, name: 'Stub Oil 10 L', category: 'Oil', unit: 'l', pack_size: 10, price: 1500, opening_stock: 30, substitute_group: `toil-${TAG}` },
    { sku: `A${TAG}-5`, name: 'Stub Oil 5 L', category: 'Oil', unit: 'l', pack_size: 5, price: 760, opening_stock: 30, substitute_group: `toil-${TAG}` },
    { sku: `A${TAG}-2`, name: 'Stub Oil 2 L', category: 'Oil', unit: 'l', pack_size: 2, price: 320, opening_stock: 30, substitute_group: `toil-${TAG}` },
    { sku: `A${TAG}-1`, name: 'Stub Oil 1 L', category: 'Oil', unit: 'l', pack_size: 1, price: 165, opening_stock: 30, substitute_group: `toil-${TAG}` },
  ];
  for (const p of prods) {
    const cr = await api('owner', 'POST', '/products', p);
    assert.equal(cr.status, 201);
    createdProductIds.push(cr.body.product.id);
  }

  const ramesh = await one(`select id from customers where phone = '9000000101'`);
  const draft = await api('staff', 'POST', '/orders', {
    customer_id: ramesh.id, items: [{ sku: `A${TAG}-10`, quantity: 2 }], idempotency_key: randomUUID(),
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const oid = draft.body.order.id;
  createdOrderIds.push(oid);
  await api('staff', 'POST', `/orders/${oid}/submit`);
  await api('staff', 'POST', `/orders/${oid}/approve`, {});
  const pick = await api('staff', 'POST', `/orders/${oid}/start-picking`);
  const itemId = pick.body.order.items[0].id;

  // 1) AI succeeds -> picks respected with AI reason.
  queue.push({ picks: [{ sku: `A${TAG}-2`, reason: 'AI picked 2L pack' }, { sku: `A${TAG}-1`, reason: 'AI picked 1L pack' }] });
  const m1 = await api('staff', 'PATCH', `/orders/${oid}/items/${itemId}/pick`, { pick_status: 'unavailable' });
  assert.equal(m1.status, 200);
  assert.equal(queue.length, 0, 'Gemini tie-breaker consumed for >2 candidates');
  assert.equal(m1.body.order.substitutions[0].product_sku, `A${TAG}-2`);
  assert.equal(m1.body.order.substitutions[0].reason, 'AI picked 2L pack');

  // 2) AI fails all 3 attempts (503, 503, 503) -> pick still succeeds via deterministic fallback!
  queue.push(503, 503, 503);
  const m2 = await api('staff', 'PATCH', `/orders/${oid}/items/${itemId}/pick`, { pick_status: 'short', packed_qty: 1 });
  assert.equal(m2.status, 200, JSON.stringify(m2.body));
  assert.equal(m2.body.order.substitutions.length, 2);
});

test('AI stub Feature 4: bill scan failure saves nothing; valid scan creates draft and logs event', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`stub-${TAG}`)]);
  const billsBefore = (await one(`select count(*)::int n from supplier_bills`)).n;
  const filesBefore = await countBillFiles();

  // Failure across 3 attempts -> 503 ai_busy, no DB row & no file on disk.
  queue.push(503, 503, 503);
  const fFail = new FormData();
  fFail.append('file', new Blob([png], { type: 'image/png' }), 'fail.png');
  const failRes = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: fFail });
  assert.equal(failRes.status, 503);
  assert.equal(failRes.body.code, 'ai_busy');
  assert.equal((await one(`select count(*)::int n from supplier_bills`)).n, billsBefore);
  assert.equal(await countBillFiles(), filesBefore);

  // Success -> draft created + ai_events logged.
  queue.push({
    supplier_name: 'Stub Traders',
    bill_number: `STUB-${TAG}`,
    bill_date: '2026-11-12',
    total: 800,
    lines: [{ sku: 'SUGAR-1KG', name: 'Sugar 1kg', quantity: 10, unit: 'kg', unit_price: 40, line_total: 400 }],
  });
  const fOk = new FormData();
  fOk.append('file', new Blob([png], { type: 'image/png' }), 'ok.png');
  const okRes = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: fOk });
  assert.equal(okRes.status, 201);
  createdBillIds.push(okRes.body.bill.id);
  const ev = await one(`select status, output from ai_events where kind = 'scan_bill' and mock = false order by id desc limit 1`);
  assert.equal(ev.status, 'ok');
});

test('AI stub Feature 6: voice Kannada intent & ai_events logs only intent metadata (no result rows)', async () => {
  queue.push({
    intent: 'customer_balance',
    period: null,
    product: null,
    customer: 'Ramesh',
    limit: null,
    language: 'kn',
    transcript: 'ರಮೇಶ್ ಬಾಕಿ ಎಷ್ಟು?',
  });

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('OggS-kn-audio')], { type: 'audio/ogg' }), 'q.ogg');
  const res = await api('owner', 'POST', '/insights/ask', undefined, { form });
  assert.equal(res.status, 200);
  assert.equal(res.body.intent, 'customer_balance');
  assert.equal(res.body.language, 'kn');
  assert.equal(res.body.transcript, 'ರಮೇಶ್ ಬಾಕಿ ಎಷ್ಟು?');
  assert.ok(res.body.answer.includes('998'));

  const ev = await one(`select output from ai_events where kind = 'ask_business' and mock = false order by id desc limit 1`);
  assert.equal(ev.output.intent, 'customer_balance');
  assert.ok(!JSON.stringify(ev.output).includes('998'), 'DB balance must not be logged in ai_events');
});

test('AI stub Feature 8: accepts safe AI reminder, rejects hallucinated number/URL, falls back cleanly on 503', async () => {
  // Use Ramesh's real balance and last payment date: other tests add payments, so they change between runs.
  const ramesh = await one(
    `select c.id, c.balance, (select max(created_at) from payments p where p.customer_id = c.id) as last_pay
     from customers c where c.phone = '9000000101'`);
  const amount = String(Number(ramesh.balance));
  const lastPay = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    .format(ramesh.last_pay);

  // 1) Safe AI draft -> source: 'ai'
  queue.push({ text: `ನಮಸ್ಕಾರ, ನಿಮ್ಮ ಬಾಕಿ ಮೊತ್ತ ₹${amount} (ಕೊನೆಯ ಪಾವತಿ ${lastPay}). ದಯವಿಟ್ಟು ಪಾವತಿಸಿ.` });
  const rOk = await api('owner', 'POST', '/reminders/draft', { customer_id: ramesh.id });
  assert.equal(rOk.status, 200);
  assert.equal(rOk.body.source, 'ai');
  assert.ok(rOk.body.text.includes(amount));

  // 2) Hallucinated extra digit -> rejected by regex/number check -> source: 'template'
  queue.push({ text: `Pay ₹${amount} plus ₹500 penalty now!` });
  const rBadNum = await api('owner', 'POST', '/reminders/draft', { customer_id: ramesh.id });
  assert.equal(rBadNum.status, 200);
  assert.equal(rBadNum.body.source, 'template');
  assert.ok(!rBadNum.body.text.includes('500'));

  // 3) AI outage (503×3) -> graceful fallback to template (200)
  queue.push(503, 503, 503);
  const rOutage = await api('owner', 'POST', '/reminders/draft', { customer_id: ramesh.id });
  assert.equal(rOutage.status, 200);
  assert.equal(rOutage.body.source, 'template');
});
