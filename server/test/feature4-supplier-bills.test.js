// Integration tests for Feature 4: Supplier bill scan, review, pack conversion, apply & duplicate guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
let server; let base; const tok = {};
const createdBillIds = [];
const appliedMovProductIds = [];

// Valid minimal PNG header + extra random bytes to avoid duplicate file hash when varied.
function fakePng(saltByte) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`test-bill-${saltByte}-${Date.now()}`),
  ]);
}

async function api(who, method, path, body, { form } = {}) {
  const headers = {};
  if (tok[who]) headers.authorization = `Bearer ${tok[who]}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return {
    status: res.status,
    headers: res.headers,
    body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()),
  };
}

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

before(async () => {
  assert.ok(config.gemini.mock, 'Tests expect Gemini mock mode.');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  for (const [who, phone] of [['owner', '9000000001'], ['staff', '9000000002'], ['ramesh', '9000000101']]) {
    const r = await api(null, 'POST', '/auth/login', { phone, password: PASSWORD });
    assert.equal(r.status, 200, `login ${who}`);
    tok[who] = r.body.token;
  }
});

after(async () => {
  if (createdBillIds.length) {
    await pool.query(`delete from stock_movements where ref_type = 'supplier_bill' and ref_id = any($1)`, [createdBillIds.map(String)]);
    // Recompute affected stock quantities from movements? Wait: apply added stock, so restore exact seeded deltas or re-seed after test suite.
    await pool.query(`delete from supplier_bills where id = any($1)`, [createdBillIds]);
  }
  server.close();
  await pool.end();
});

test('Feature 4: role guard & magic byte upload validation', async () => {
  assert.equal((await api('staff', 'GET', '/supplier-bills')).status, 403);
  assert.equal((await api('ramesh', 'GET', '/supplier-bills')).status, 403);

  // Non-image bytes disguised as PNG rejected with 400.
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('not-an-image')], { type: 'image/png' }), 'fake.png');
  assert.equal((await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: badForm })).status, 400);
});

test('Feature 4: scan -> private file -> validation -> apply merges duplicate lines -> duplicate guards -> discard', async () => {
  const sugar = await one(`select id, stock_qty from products where sku = 'SUGAR-1KG'`);
  const tea = await one(`select id, stock_qty from products where sku = 'TEA-250G'`);
  appliedMovProductIds.push(sugar.id, tea.id);

  const img1 = fakePng(1);
  const f1 = new FormData();
  f1.append('file', new Blob([img1], { type: 'image/png' }), 'bill1.png');
  const s1 = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: f1 });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  const bill1 = s1.body.bill;
  createdBillIds.push(bill1.id);
  assert.equal(bill1.status, 'draft');
  assert.equal(bill1.has_file, true);
  assert.ok(bill1.matched_lines.length >= 2);
  assert.equal(bill1.matched_lines[0].matched_sku, 'SUGAR-1KG');

  // Owner can download stored photo with no-store header; non-owner blocked.
  assert.equal((await api('staff', 'GET', `/supplier-bills/${bill1.id}/file`)).status, 403);
  const fileRes = await api('owner', 'GET', `/supplier-bills/${bill1.id}/file`);
  assert.equal(fileRes.status, 200);
  assert.match(fileRes.headers.get('cache-control') || '', /no-store/);
  assert.equal(Buffer.compare(fileRes.body, img1), 0);

  // Validation: unmatched non-skipped line -> 400; all skipped -> 400.
  assert.equal((await api('owner', 'POST', `/supplier-bills/${bill1.id}/apply`, {
    supplier_name: 'Supplier X',
    bill_number: 'INV-101',
    bill_date: '2026-11-10',
    lines: [{ product_id: null, packs: 5, skip: false }],
  })).status, 400);
  assert.equal((await api('owner', 'POST', `/supplier-bills/${bill1.id}/apply`, {
    lines: [{ product_id: null, skip: true }],
  })).status, 400);

  // Apply two lines targeting SUGAR-1KG + one TEA-250G -> merges into ONE inward movement for SUGAR-1KG!
  const ap1 = await api('owner', 'POST', `/supplier-bills/${bill1.id}/apply`, {
    supplier_name: 'Sri Ganesh Wholesale',
    bill_number: 'BILL-001',
    bill_date: '2026-11-10',
    lines: [
      { product_id: sugar.id, packs: 10, unit_cost: 40, skip: false },
      { product_id: sugar.id, packs: 5, unit_cost: 43, skip: false },
      { product_id: tea.id, packs: 4, unit_cost: 90, skip: false },
    ],
  });
  assert.equal(ap1.status, 200, JSON.stringify(ap1.body));
  assert.equal(ap1.body.bill.status, 'applied');

  const sugarAfter = await one(`select stock_qty from products where id = $1`, [sugar.id]);
  const teaAfter = await one(`select stock_qty from products where id = $1`, [tea.id]);
  assert.equal(sugarAfter.stock_qty, sugar.stock_qty + 15);
  assert.equal(teaAfter.stock_qty, tea.stock_qty + 4);
  const movCount = await one(
    `select count(*)::int n from stock_movements where ref_type = 'supplier_bill' and ref_id = $1`,
    [bill1.id],
  );
  assert.equal(movCount.n, 2, 'One merged movement per product per bill');

  // Re-applying already applied bill -> 409.
  assert.equal((await api('owner', 'POST', `/supplier-bills/${bill1.id}/apply`, {
    lines: [{ product_id: tea.id, packs: 1, skip: false }],
  })).status, 409);

  // Duplicate photo SHA-256 guard: scanning exact same image warns and blocks apply with 409.
  const fDupImg = new FormData();
  fDupImg.append('file', new Blob([img1], { type: 'image/png' }), 'bill1-copy.png');
  const sDupImg = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: fDupImg });
  assert.equal(sDupImg.status, 201);
  createdBillIds.push(sDupImg.body.bill.id);
  assert.ok(sDupImg.body.bill.warnings.some((w) => w.includes('already been applied')));
  assert.equal((await api('owner', 'POST', `/supplier-bills/${sDupImg.body.bill.id}/apply`, {
    supplier_name: 'Other',
    bill_number: 'BILL-999',
    bill_date: '2026-11-11',
    lines: [{ product_id: tea.id, packs: 1, skip: false }],
  })).status, 409);

  // Duplicate (supplier_name, bill_number, bill_date) case/trim-insensitive -> 409.
  const f2 = new FormData();
  f2.append('file', new Blob([fakePng(2)], { type: 'image/png' }), 'bill2.png');
  const s2 = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: f2 });
  assert.equal(s2.status, 201);
  createdBillIds.push(s2.body.bill.id);
  assert.equal((await api('owner', 'POST', `/supplier-bills/${s2.body.bill.id}/apply`, {
    supplier_name: '  sri ganesh wholesale ',
    bill_number: 'bill-001',
    bill_date: '2026-11-10',
    lines: [{ product_id: tea.id, packs: 1, skip: false }],
  })).status, 409);

  // Missing bill_number on same supplier + date triggers 409 confirm_duplicate_date, overridden with confirm_duplicate_date: true.
  const warnSameDate = await api('owner', 'POST', `/supplier-bills/${s2.body.bill.id}/apply`, {
    supplier_name: 'Sri Ganesh Wholesale',
    bill_number: null,
    bill_date: '2026-11-10',
    lines: [{ product_id: tea.id, packs: 2, skip: false }],
  });
  assert.equal(warnSameDate.status, 409);
  assert.equal(warnSameDate.body.code, 'confirm_duplicate_date');

  const confirmed = await api('owner', 'POST', `/supplier-bills/${s2.body.bill.id}/apply`, {
    supplier_name: 'Sri Ganesh Wholesale',
    bill_number: null,
    bill_date: '2026-11-10',
    confirm_duplicate_date: true,
    lines: [{ product_id: tea.id, packs: 2, skip: false }],
  });
  assert.equal(confirmed.status, 200);

  // Discard workflow + idempotency + restore stock_qty back cleanly.
  const f3 = new FormData();
  f3.append('file', new Blob([fakePng(3)], { type: 'image/png' }), 'bill3.png');
  const s3 = await api('owner', 'POST', '/supplier-bills/scan', undefined, { form: f3 });
  assert.equal(s3.status, 201);
  const bill3Id = s3.body.bill.id;
  createdBillIds.push(bill3Id);
  const d1 = await api('owner', 'POST', `/supplier-bills/${bill3Id}/discard`);
  assert.equal(d1.status, 200);
  assert.equal(d1.body.bill.status, 'discarded');
  assert.equal((await api('owner', 'POST', `/supplier-bills/${bill3Id}/discard`)).status, 200);
  assert.equal((await api('owner', 'POST', `/supplier-bills/${bill3Id}/apply`, {
    lines: [{ product_id: tea.id, packs: 1, skip: false }],
  })).status, 409);

  // Restore modified stock_qty cleanly so seeded invariants hold across test files.
  await pool.query('update products set stock_qty = $2 where id = $1', [sugar.id, sugar.stock_qty]);
  await pool.query('update products set stock_qty = $2 where id = $1', [tea.id, tea.stock_qty]);
});
