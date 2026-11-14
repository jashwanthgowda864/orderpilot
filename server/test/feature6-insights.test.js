// Integration tests for Feature 6: Ask your business (owner-only Q&A, intents, SQL truth, languages).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { UNKNOWN_ANSWER } from '../src/services/insights.js';

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
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

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
  server.close();
  await pool.end();
});

test('Feature 6: owner-only guard & validation', async () => {
  assert.equal((await api('staff', 'POST', '/insights/ask', { question: 'Who owes the most?' })).status, 403);
  assert.equal((await api('ramesh', 'POST', '/insights/ask', { question: 'Who owes the most?' })).status, 403);
  assert.equal((await api('owner', 'POST', '/insights/ask', {})).status, 400);
});

test('Feature 6: all 7 intents, unknown intent, Kannada/Hindi localization, and voice fallback', async () => {
  // 1. sales_by_period
  const sbp = await api('owner', 'POST', '/insights/ask', { question: 'Total sales this month?' });
  assert.equal(sbp.status, 200);
  assert.equal(sbp.body.intent, 'sales_by_period');
  assert.equal(sbp.body.params.period, 'this_month');
  assert.deepEqual(sbp.body.columns, ['Period', 'Invoices', 'Total']);

  // 2. sales_by_product
  const prod = await api('owner', 'POST', '/insights/ask', { question: 'How much sugar sold last 30 days?' });
  assert.equal(prod.status, 200);
  assert.equal(prod.body.intent, 'sales_by_product');
  assert.ok(Array.isArray(prod.body.rows));

  // 3. top_products
  const top = await api('owner', 'POST', '/insights/ask', { question: 'Top 5 products last 30 days' });
  assert.equal(top.status, 200);
  assert.equal(top.body.intent, 'top_products');
  assert.equal(top.body.params.limit, 5);
  assert.ok(top.body.rows.length <= 5);

  // 4. top_outstanding_customers matches DB truth
  const owe = await api('owner', 'POST', '/insights/ask', { question: 'Who owes the most?' });
  assert.equal(owe.status, 200);
  assert.equal(owe.body.intent, 'top_outstanding_customers');
  assert.ok(owe.body.rows.length >= 1);
  assert.ok(owe.body.rows[0][0].includes('Anita') || owe.body.rows[0][0].includes('Ramesh'));

  // 5. customer_balance
  const ram = await api('owner', 'POST', '/insights/ask', { question: 'How much does Ramesh owe?' });
  assert.equal(ram.status, 200);
  assert.equal(ram.body.intent, 'customer_balance');
  assert.ok(ram.body.answer.includes('998'));

  // 6. low_stock
  const low = await api('owner', 'POST', '/insights/ask', { question: 'Which items are low stock?' });
  assert.equal(low.status, 200);
  assert.equal(low.body.intent, 'low_stock');

  // 7. orders_by_status
  const ord = await api('owner', 'POST', '/insights/ask', { question: 'How many orders by status?' });
  assert.equal(ord.status, 200);
  assert.equal(ord.body.intent, 'orders_by_status');
  assert.ok(ord.body.rows.length >= 1);

  // Unknown question
  const unk = await api('owner', 'POST', '/insights/ask', { question: 'Will it rain tomorrow?' });
  assert.equal(unk.status, 200);
  assert.equal(unk.body.intent, 'unknown');
  assert.equal(unk.body.answer, UNKNOWN_ANSWER);

  // Kannada & Hindi localization
  const kn = await api('owner', 'POST', '/insights/ask', { question: 'ಈ ತಿಂಗಳ sales this month' });
  assert.equal(kn.status, 200);
  assert.equal(kn.body.language, 'kn');
  assert.ok(/[\u0C80-\u0CFF]/.test(kn.body.answer), 'Kannada answer uses Kannada script');

  const hi = await api('owner', 'POST', '/insights/ask', { question: 'इस महीने sales this month' });
  assert.equal(hi.status, 200);
  assert.equal(hi.body.language, 'hi');
  assert.ok(/[\u0900-\u097F]/.test(hi.body.answer), 'Hindi answer uses Devanagari script');

  // Audio upload works cleanly (multipart voice note)
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('OggS')], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('question', 'Who owes the most?');
  const voice = await api('owner', 'POST', '/insights/ask', undefined, { form });
  assert.equal(voice.status, 200);
  assert.equal(voice.body.intent, 'top_outstanding_customers');
});
