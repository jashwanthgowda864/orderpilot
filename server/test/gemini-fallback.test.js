// Gemini failure policy: retry once on 503/timeout, then the lighter fallback
// model, then "AI is busy". Google is simulated by stubbing fetch, so this runs
// offline and costs nothing. Node runs each test file in its own process, so the
// env set here does not leak into other tests.
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

const { parseOrder, AI_BUSY_MESSAGE } = await import('../src/services/gemini.js');
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { readdir } = await import('node:fs/promises');
const storedFiles = async () => (await readdir(config.storage.localDir, { recursive: true }).catch(() => [])).filter((f) => /\.(jpg|png|webp|webm|m4a|ogg|mp3|wav)$/.test(f)).length;

const CATALOG = [{ sku: 'SUGAR-1KG', name: 'Sugar 1 kg', unit: 'kg', pack_size: 1, aliases: ['sugar'] }];
const GOOD = { language: 'en', transcript: null, items: [{ sku: 'SUGAR-1KG', name: 'sugar', quantity: 2, unit: 'kg', confidence: 'high', candidates: [] }], questions: [] };

// Each Gemini call takes the next behaviour from the queue.
let queue = []; let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, init);
  calls.push(decodeURIComponent(u.split('/models/')[1].split(':')[0]));
  const b = queue.shift() ?? 'ok';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (b === 'timeout') {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }
  if (b === 'network') throw new TypeError('fetch failed');
  if (b === 'quota') return json(429, { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.' } });
  if (typeof b === 'number') return json(b, { error: { code: b, message: 'simulated' } });
  const out = b === 'bad' ? { language: 'en', items: [{ name: 'x', confidence: 'high', quantity: 'lots' }] } : GOOD;
  return json(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(out) }] } }] });
};

beforeEach(() => { queue = []; calls = []; });
const lastEvents = async (n) => (await pool.query('select model, status, error from ai_events order by id desc limit $1', [n])).rows.reverse();

test('success on first try uses the main model once', async () => {
  queue = ['ok'];
  const r = await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.equal(r.items[0].sku, 'SUGAR-1KG');
  assert.deepEqual(calls, ['main-model']);
});

test('503 then success: retries the main model once', async () => {
  queue = [503, 'ok'];
  await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.deepEqual(calls, ['main-model', 'main-model']);
});

test('503 twice: falls back to the lighter model, and every attempt is logged', async () => {
  queue = [503, 'timeout', 'ok'];
  const r = await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.equal(r.items[0].quantity, 2);
  assert.deepEqual(calls, ['main-model', 'main-model', 'lite-model']);
  const ev = await lastEvents(3);
  assert.deepEqual(ev.map((e) => [e.model, e.status]), [['main-model', 'error'], ['main-model', 'error'], ['lite-model', 'ok']]);
  assert.match(ev[0].error, /^main: HTTP 503/);
  assert.match(ev[1].error, /^main-retry: timed out/);
  assert.match(ev[2].error, /fallback/);
});

test('everything fails: "AI is busy" (503, code ai_busy) after exactly 3 attempts', async () => {
  queue = ['timeout', 503, 'network'];
  await assert.rejects(parseOrder({ text: '2 sugar', catalog: CATALOG }), (err) => {
    assert.equal(err.status, 503); assert.equal(err.code, 'ai_busy'); assert.equal(err.message, AI_BUSY_MESSAGE);
    return true;
  });
  assert.deepEqual(calls, ['main-model', 'main-model', 'lite-model']);
});

test('429 quota exceeded skips the retry and goes straight to the fallback', async () => {
  queue = ['quota', 'ok'];
  await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.deepEqual(calls, ['main-model', 'lite-model']);
});

test('non-transient error (400) or an invalid answer skips the retry and goes straight to the fallback', async () => {
  queue = [400, 'ok'];
  await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.deepEqual(calls, ['main-model', 'lite-model']);
  calls = []; queue = ['bad', 'ok'];
  await parseOrder({ text: '2 sugar', catalog: CATALOG });
  assert.deepEqual(calls, ['main-model', 'lite-model']);
});

// ---- Through the API: nothing is written when the AI is busy; the same input can be retried.
let server; let base; let token;
before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  const r = await realFetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '9000000102', password: process.env.SEED_PASSWORD || 'orderpilot-demo' }) });
  token = (await r.json()).token;
});
after(async () => { server.close(); await pool.end(); });

test('API: AI busy -> 503 with a clear message, no order or file saved; retry with the same key succeeds', async () => {
  const count = async () => (await pool.query('select (select count(*) from orders)::int o, (select count(*) from order_items)::int i')).rows[0];
  const before_ = await count();
  const filesBefore = await storedFiles();
  const key = randomUUID();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  const send = () => {
    const fd = new FormData();
    fd.set('file', new Blob([jpeg], { type: 'image/jpeg' }), 'list.jpg');
    fd.set('idempotency_key', key);
    return realFetch(`${base}/orders/parse`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  };

  queue = [503, 503, 503];
  let res = await send();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual([body.code, body.error], ['ai_busy', AI_BUSY_MESSAGE]);
  assert.deepEqual(await count(), before_, 'nothing written when the AI is busy');
  assert.equal(await storedFiles(), filesBefore, 'no file stored when the AI is busy');

  queue = ['ok'];
  res = await send();
  assert.equal(res.status, 201);
  const { order } = await res.json();
  assert.equal(order.items[0].sku, 'SUGAR-1KG');
  assert.equal(order.has_file, true);
  assert.equal((await count()).o, before_.o + 1);
  assert.equal(await storedFiles(), filesBefore + 1);
});
