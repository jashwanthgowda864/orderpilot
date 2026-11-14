import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/error.js';
import { allowedNext, EDITABLE, recordInitialStatus, transition } from './rules.js';
import { parseOrder } from './gemini.js';
import { rankProducts, allowsFraction } from './catalogMatch.js';
import { uploadFile, removeFile } from './storage.js';

const round2 = (n) => Math.round(n * 100) / 100;

export async function loadCatalog(db = pool) {
  const { rows } = await db.query(
    `select id, sku, name, name_kn, name_hi, aliases, category, unit, pack_size, price, stock_qty
     from products where active order by category, name`,
  );
  return rows;
}

const optionOf = (p) => ({ sku: p.sku, name: p.name, unit: p.unit, pack_size: Number(p.pack_size), price: Number(p.price) });
const packLabel = (p) => `${Number(p.pack_size)} ${p.unit}`;

/** Resolve which customer an order is for, enforcing role rules. */
export async function resolveCustomerId(user, requestedId, db = pool) {
  if (user.role === 'customer') {
    if (requestedId && requestedId !== user.customer_id) throw forbidden();
    return user.customer_id;
  }
  if (!requestedId) throw badRequest('Choose the customer for this order.');
  const { rows } = await db.query('select id, active from customers where id = $1', [requestedId]);
  if (!rows[0]) throw notFound('Customer not found.');
  if (!rows[0].active) throw badRequest('This customer account is disabled.');
  return requestedId;
}

/** Loads an order row (optionally locked) and enforces that customers only see their own. */
export async function getOrderRow(db, id, user, { lock = false } = {}) {
  const { rows } = await db.query(`select * from orders where id = $1 ${lock ? 'for update' : ''}`, [id]);
  const order = rows[0];
  if (!order || (user.role === 'customer' && order.customer_id !== user.customer_id)) throw notFound('Order not found.');
  return order;
}

export async function getOrderDetail(id, user, db = pool) {
  const order = await getOrderRow(db, id, user);
  const [cust, items, clar, hist, inv] = await Promise.all([
    db.query('select id, name, phone, balance, preferred_language from customers where id = $1', [order.customer_id]),
    db.query(
      `select oi.*, p.stock_qty, p.pack_size, p.category
       from order_items oi left join products p on p.id = oi.product_id
       where oi.order_id = $1 order by oi.position, oi.created_at`, [id]),
    db.query('select * from order_clarifications where order_id = $1 order by created_at', [id]),
    db.query(
      `select h.from_status, h.to_status, h.note, h.created_at, u.name as changed_by_name
       from order_status_history h left join users u on u.id = h.changed_by
       where h.order_id = $1 order by h.created_at, h.id`, [id]),
    db.query('select * from invoices where order_id = $1', [id]),
  ]);
  // Feature 1: which earlier order this one was based on (same customer only).
  const basedOn = order.based_on_order_id
    ? (await db.query('select id, order_no, created_at from orders where id = $1 and customer_id = $2',
      [order.based_on_order_id, order.customer_id])).rows[0] || null
    : null;
  const { input_file_path, idempotency_key, ...rest } = order;
  const items_ = items.rows.map((it) => {
    if (user.role === 'customer') { const { stock_qty, ...pub } = it; return pub; }
    return it;
  });
  return {
    ...rest,
    has_file: Boolean(input_file_path),
    customer: cust.rows[0] || null,
    items: items_,
    clarifications: clar.rows,
    history: hist.rows,
    invoice: inv.rows[0] || null,
    based_on: basedOn,
    allowed_actions: allowedNext(order.status, user.role),
  };
}

/**
 * Feature 1: the customer's most recent collected or ready order, used as context
 * for "same as last time". Returns null when there is none. Uses what was ordered
 * (not substitutes), and skips lines that were never matched to a product.
 */
export async function loadPreviousOrder(customerId, db = pool) {
  const { rows } = await db.query(
    `select id, order_no, created_at from orders
     where customer_id = $1 and status in ('collected', 'ready')
     order by created_at desc limit 1`, [customerId]);
  if (!rows[0]) return null;
  const { rows: items } = await db.query(
    `select sku, name, quantity from order_items
     where order_id = $1 and product_id is not null and coalesce(origin, '') <> 'substitution'
     order by position, created_at`, [rows[0].id]);
  if (!items.length) return null;
  return { id: rows[0].id, order_no: rows[0].order_no, date: rows[0].created_at.toISOString().slice(0, 10), items };
}

export async function listOrders(user, { status, customer_id, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (user.role === 'customer') { params.push(user.customer_id); where.push(`o.customer_id = $${params.length}`); }
  else if (customer_id) { params.push(customer_id); where.push(`o.customer_id = $${params.length}`); }
  if (status?.length) { params.push(status); where.push(`o.status = any($${params.length})`); }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `select o.id, o.order_no, o.status, o.channel, o.subtotal, o.created_at, o.updated_at, o.approved_at, o.ready_at,
            c.name as customer_name, c.id as customer_id,
            (select count(*)::int from order_items i where i.order_id = o.id) as item_count,
            (select count(*)::int from order_clarifications q where q.order_id = o.id and q.answered_at is null) as open_questions,
            inv.total as invoice_total
     from orders o join customers c on c.id = o.customer_id
     left join invoices inv on inv.order_id = o.id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by o.created_at desc limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Turning a parse result into items + clarification questions
// ---------------------------------------------------------------------------
export const NO_PREVIOUS_ORDER_QUESTION = "We don't have an earlier order for you yet. What would you like to order?";

/**
 * @param parsed         validated model output
 * @param catalog        active products
 * @param previousOrder  feature 1 context (or null). An item counts as "from the previous
 *                       order" only if the model says so AND its SKU really is in that order.
 */
export function buildDraft(parsed, catalog, previousOrder = null) {
  const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));
  const prevSkus = new Set((previousOrder?.items || []).map((i) => String(i.sku || '').toLowerCase()).filter(Boolean));

  // Never list the same product twice: merge lines with the same known SKU ("usual + 2 sugar").
  const lines = [];
  const seen = new Map();
  for (const it of parsed.items) {
    const key = it.sku ? it.sku.toLowerCase() : null;
    const dup = key && seen.get(key);
    if (dup) {
      dup.quantity = dup.quantity != null && it.quantity != null ? dup.quantity + it.quantity : (dup.quantity ?? it.quantity);
      dup.from_previous = dup.from_previous || it.from_previous;
      continue;
    }
    const copy = { ...it };
    lines.push(copy);
    if (key) seen.set(key, copy);
  }

  const items = [];
  for (const it of lines) {
    const key = it.sku ? it.sku.toLowerCase() : null;
    const product = key ? bySku.get(key) : null;
    const origin = it.from_previous && key && prevSkus.has(key) ? 'previous_order' : 'parsed';
    const questions = [];
    if (!product) {
      let options = it.candidates.map((s) => bySku.get(s.toLowerCase())).filter(Boolean);
      if (!options.length) options = rankProducts(it.name, catalog, 4).map((r) => r.p);
      questions.push({
        kind: 'choose_product',
        question: origin === 'previous_order'
          ? `"${it.name}" from your last order is not available now. Pick another product or remove it.`
          : options.length
            ? `Which product did you mean by "${it.name}"?`
            : `We couldn't find "${it.name}" in the shop's list. Pick a product or remove it.`,
        options: options.slice(0, 4).map(optionOf),
      });
    }
    let quantity = it.quantity;
    if (quantity == null) {
      questions.push({
        kind: 'quantity',
        question: product ? `How many ${packLabel(product)} packs of ${product.name}?` : `How many of "${it.name}"?`,
        options: [],
      });
      quantity = 1;
    } else if (product && !allowsFraction(product) && !Number.isInteger(quantity)) {
      const up = Math.ceil(quantity);
      questions.push({
        kind: 'quantity',
        question: `${product.name} comes in ${packLabel(product)} packs. You asked for ${quantity} packs — how many packs?`,
        options: [{ quantity: up }, ...(Math.floor(quantity) > 0 ? [{ quantity: Math.floor(quantity) }] : [])],
      });
      quantity = up;
    }
    items.push({ product, name: product ? product.name : it.name, quantity, unit: product?.unit || it.unit,
      confidence: it.confidence, origin, questions });
  }
  const general = parsed.questions.map((q) => ({ kind: 'free_text', question: q.question, options: [] }));
  // Asked for "the usual" but there is no earlier order: ask instead of guessing.
  if (parsed.refers_to_previous && !previousOrder) {
    general.push({ kind: 'free_text', question: NO_PREVIOUS_ORDER_QUESTION, options: [] });
  }
  const basedOnOrderId = previousOrder && (parsed.refers_to_previous || items.some((i) => i.origin === 'previous_order'))
    ? previousOrder.id : null;
  return { items, general, basedOnOrderId };
}

async function insertItems(client, orderId, items, startPos = 0) {
  const inserted = [];
  for (const [i, it] of items.entries()) {
    const { rows } = await client.query(
      `insert into order_items (order_id, position, product_id, sku, name, quantity, unit, unit_price, confidence, origin)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [orderId, startPos + i, it.product?.id ?? null, it.product?.sku ?? null, it.name, it.quantity,
        it.unit ?? null, it.product ? it.product.price : null, it.confidence ?? null, it.origin ?? null],
    );
    inserted.push(rows[0]);
    for (const q of it.questions || []) {
      await client.query(
        `insert into order_clarifications (order_id, item_id, kind, question, options) values ($1,$2,$3,$4,$5)`,
        [orderId, rows[0].id, q.kind, q.question, JSON.stringify(q.options)],
      );
    }
  }
  return inserted;
}

async function recomputeSubtotal(client, orderId) {
  await client.query(
    `update orders set subtotal = coalesce((select sum(round(quantity * coalesce(unit_price,0), 2))
       from order_items where order_id = $1), 0), updated_at = now() where id = $1`,
    [orderId],
  );
}

async function findByIdempotencyKey(key, user) {
  if (!key) return null;
  const { rows } = await pool.query('select id, created_by from orders where idempotency_key = $1', [key]);
  if (!rows[0]) return null;
  if (rows[0].created_by !== user.id) throw conflict('This request key was already used.');
  return rows[0].id;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' };
export const ALLOWED_MIME = new Set(Object.keys(EXT));

/**
 * Text / photo / voice order. Gemini is called first; nothing is written to the
 * database or storage unless parsing succeeds, and the order is created in one
 * transaction.
 */
export async function createOrderFromInput({ user, customerId, text, file, idempotencyKey, notes }) {
  const existing = await findByIdempotencyKey(idempotencyKey, user);
  if (existing) return { orderId: existing, duplicate: true };

  const custId = await resolveCustomerId(user, customerId);
  if (!text && !file) throw badRequest('Type your order, or attach a photo or voice note.');
  const channel = file ? (file.mimetype.startsWith('audio/') ? 'voice' : 'photo') : 'text';

  const catalog = await loadCatalog();
  const previousOrder = await loadPreviousOrder(custId); // feature 1: context only when it exists
  const parseStartedAt = new Date();
  const parsed = await parseOrder({ text, file, catalog, userId: user.id, previousOrder });
  const draft = buildDraft(parsed, catalog, previousOrder);
  if (!draft.items.length && !draft.general.length) {
    throw badRequest("We couldn't find any items in that. Please list the items and quantities.");
  }

  let filePath = null;
  if (file) {
    const d = new Date();
    filePath = `orders/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXT[file.mimetype]}`;
    await uploadFile(filePath, file.buffer, file.mimetype);
  }

  try {
    const orderId = await withTransaction(async (client) => {
      const needsQ = draft.general.length > 0 || draft.items.some((i) => i.questions.length);
      const status = needsQ ? 'needs_clarification' : 'draft';
      const { rows } = await client.query(
        `insert into orders (customer_id, created_by, channel, status, raw_text, transcript, input_file_path, language, notes,
           idempotency_key, based_on_order_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [custId, user.id, channel, status, text || null, parsed.transcript, filePath, parsed.language, notes || null,
          idempotencyKey || null, draft.basedOnOrderId],
      );
      const id = rows[0].id;
      await insertItems(client, id, draft.items);
      for (const q of draft.general) {
        await client.query(
          `insert into order_clarifications (order_id, kind, question, options) values ($1,'free_text',$2,'[]')`, [id, q.question]);
      }
      await recomputeSubtotal(client, id);
      await recordInitialStatus(client, id, status, user.id, user.role === 'customer' ? null : 'counter');
      return id;
    });
    // Link every AI attempt of this request (incl. failed tries before a retry/fallback) to the order.
    await pool.query(
      `update ai_events set order_id = $1
       where user_id = $2 and kind = 'parse_order' and order_id is null and created_at >= $3`,
      [orderId, user.id, parseStartedAt],
    );
    return { orderId, duplicate: false };
  } catch (err) {
    if (filePath) await removeFile(filePath);
    if (err.code === '23505' && idempotencyKey) {
      const id = await findByIdempotencyKey(idempotencyKey, user);
      if (id) return { orderId: id, duplicate: true };
    }
    throw err;
  }
}

/** Staff/owner counter order from explicit SKUs (no AI). */
export async function createManualOrder({ user, customerId, items, notes, idempotencyKey }) {
  const existing = await findByIdempotencyKey(idempotencyKey, user);
  if (existing) return { orderId: existing, duplicate: true };
  const custId = await resolveCustomerId(user, customerId);
  const catalog = await loadCatalog();
  const resolved = resolveSkuItems(items, catalog);
  const orderId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into orders (customer_id, created_by, channel, status, notes, idempotency_key)
       values ($1,$2,'counter','draft',$3,$4) returning id`,
      [custId, user.id, notes || null, idempotencyKey || null],
    );
    await insertItems(client, rows[0].id, resolved);
    await recomputeSubtotal(client, rows[0].id);
    await recordInitialStatus(client, rows[0].id, 'draft', user.id, 'counter');
    return rows[0].id;
  });
  return { orderId, duplicate: false };
}

function resolveSkuItems(items, catalog) {
  const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));
  return items.map((it) => {
    const p = bySku.get(it.sku.toLowerCase());
    if (!p) throw badRequest(`Unknown or inactive product ${it.sku}.`);
    if (!allowsFraction(p) && !Number.isInteger(it.quantity)) throw badRequest(`${p.name} must be ordered in whole packs.`);
    return { product: p, name: p.name, quantity: it.quantity, unit: p.unit, confidence: null, origin: 'manual', questions: [] };
  });
}

/**
 * Review screen edit (draft only). Items with an id are updated in place (keeping
 * their confidence if the SKU is unchanged); new ones are inserted; missing ones removed.
 */
export async function updateItems(orderId, user, items) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status !== 'draft') throw conflict('Items can only be changed before the order is submitted.');
    const catalog = await loadCatalog(client);
    const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));
    const { rows: current } = await client.query('select * from order_items where order_id = $1', [orderId]);
    const currentById = new Map(current.map((r) => [r.id, r]));
    const seen = new Set();
    for (const [pos, it] of items.entries()) {
      const p = bySku.get(it.sku.toLowerCase());
      if (!p) throw badRequest(`Unknown or inactive product ${it.sku}.`);
      if (!allowsFraction(p) && !Number.isInteger(it.quantity)) throw badRequest(`${p.name} must be ordered in whole packs.`);
      if (it.id) {
        const cur = currentById.get(it.id);
        if (!cur) throw badRequest('One of the items does not belong to this order.');
        seen.add(it.id);
        const sameProduct = cur.product_id === p.id;
        await client.query(
          // Swapping the product makes it a manual line: its AI confidence and origin no longer apply.
          `update order_items set position=$2, product_id=$3, sku=$4, name=$5, quantity=$6, unit=$7, unit_price=$8,
             confidence = case when $9 then confidence else null end,
             origin = case when $9 then origin else 'manual' end where id = $1`,
          [it.id, pos, p.id, p.sku, p.name, it.quantity, p.unit, p.price, sameProduct],
        );
      } else {
        await insertItems(client, orderId, [{ product: p, name: p.name, quantity: it.quantity, unit: p.unit, confidence: null, origin: 'manual' }], pos);
      }
    }
    const toDelete = current.filter((r) => !seen.has(r.id)).map((r) => r.id);
    if (toDelete.length) await client.query('delete from order_items where id = any($1)', [toDelete]);
    await recomputeSubtotal(client, orderId);
    return orderId;
  });
}

/**
 * Feature 1 (approved decision 4): a free-text answer on an order that has no items
 * yet (e.g. "We don't have an earlier order for you — what would you like?") is read
 * like a new order. The AI call happens BEFORE the transaction so no lock is held while
 * waiting, and nothing is written if it fails (AiBusyError) or finds no items.
 */
async function parseAnswerIfOrderIsEmpty(orderId, clarId, user, answer) {
  if (answer.skip || !answer.text) return null;
  const order = await getOrderRow(pool, orderId, user);
  if (order.status !== 'needs_clarification') return null;
  const { rows } = await pool.query(
    `select q.kind, q.answered_at, (select count(*)::int from order_items i where i.order_id = q.order_id) as item_count
     from order_clarifications q where q.id = $1 and q.order_id = $2`, [clarId, orderId]);
  const q = rows[0];
  if (!q || q.kind !== 'free_text' || q.answered_at || q.item_count > 0) return null;
  const catalog = await loadCatalog();
  const previousOrder = await loadPreviousOrder(order.customer_id);
  const parsed = await parseOrder({ text: answer.text, catalog, userId: user.id, orderId, previousOrder });
  const draft = buildDraft(parsed, catalog, previousOrder);
  // Don't ask "what would you like?" again for the same order.
  draft.general = draft.general.filter((g) => g.question !== NO_PREVIOUS_ORDER_QUESTION);
  if (!draft.items.length) throw badRequest("We couldn't find any items in that. Please list the items and quantities.");
  return draft;
}

export async function answerClarification(orderId, clarId, user, answer) {
  const draftFromAnswer = await parseAnswerIfOrderIsEmpty(orderId, clarId, user, answer);
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status !== 'needs_clarification') throw conflict('This order has no open questions.');
    const { rows } = await client.query('select * from order_clarifications where id = $1 and order_id = $2', [clarId, orderId]);
    const q = rows[0];
    if (!q) throw notFound('Question not found.');
    if (q.answered_at) throw conflict('This question was already answered.');

    if (draftFromAnswer) {
      // Re-check under the lock: someone may have added items while the AI was reading.
      const { rows: cnt } = await client.query('select count(*)::int as n from order_items where order_id = $1', [orderId]);
      if (cnt[0].n === 0) {
        await insertItems(client, orderId, draftFromAnswer.items);
        for (const g of draftFromAnswer.general) {
          await client.query(`insert into order_clarifications (order_id, kind, question, options) values ($1,'free_text',$2,'[]')`,
            [orderId, g.question]);
        }
        if (draftFromAnswer.basedOnOrderId && !order.based_on_order_id) {
          await client.query('update orders set based_on_order_id = $2 where id = $1', [orderId, draftFromAnswer.basedOnOrderId]);
        }
      }
    }

    if (answer.skip) {
      if (q.item_id) {
        await client.query('delete from order_items where id = $1', [q.item_id]); // cascades its other questions
      } else {
        await client.query('update order_clarifications set answer=$2, answered_by=$3, answered_at=now() where id=$1',
          [q.id, JSON.stringify({ skip: true }), user.id]);
      }
    } else if (q.kind === 'choose_product') {
      if (!answer.sku) throw badRequest('Choose a product.');
      const { rows: pr } = await client.query('select * from products where lower(sku) = lower($1) and active', [answer.sku]);
      const p = pr[0];
      if (!p) throw badRequest('That product is not available.');
      const { rows: itr } = await client.query('select quantity from order_items where id = $1', [q.item_id]);
      let quantity = itr[0]?.quantity ?? 1;
      if (!allowsFraction(p) && !Number.isInteger(Number(quantity))) quantity = Math.ceil(quantity);
      await client.query(
        `update order_items set product_id=$2, sku=$3, name=$4, unit=$5, unit_price=$6, quantity=$7, confidence='high' where id=$1`,
        [q.item_id, p.id, p.sku, p.name, p.unit, p.price, quantity],
      );
      await client.query('update order_clarifications set answer=$2, answered_by=$3, answered_at=now() where id=$1',
        [q.id, JSON.stringify({ sku: p.sku }), user.id]);
    } else if (q.kind === 'quantity') {
      if (!answer.quantity) throw badRequest('Enter a quantity.');
      const { rows: itr } = await client.query(
        `select p.unit, p.pack_size, p.name from order_items i left join products p on p.id = i.product_id where i.id = $1`, [q.item_id]);
      const p = itr[0];
      if (p?.unit && !allowsFraction(p) && !Number.isInteger(answer.quantity)) throw badRequest(`${p.name} must be ordered in whole packs.`);
      await client.query('update order_items set quantity = $2 where id = $1', [q.item_id, answer.quantity]);
      await client.query('update order_clarifications set answer=$2, answered_by=$3, answered_at=now() where id=$1',
        [q.id, JSON.stringify({ quantity: answer.quantity }), user.id]);
    } else {
      if (!answer.text) throw badRequest('Type an answer.');
      await client.query(`update orders set notes = concat_ws(E'\n', notes, $2::text) where id = $1`,
        [orderId, `Q: ${q.question}\nA: ${answer.text}`]);
      await client.query('update order_clarifications set answer=$2, answered_by=$3, answered_at=now() where id=$1',
        [q.id, JSON.stringify({ text: answer.text }), user.id]);
    }

    await recomputeSubtotal(client, orderId);
    const { rows: open } = await client.query(
      'select count(*)::int as n from order_clarifications where order_id = $1 and answered_at is null', [orderId]);
    if (open[0].n === 0) await transition(client, order, 'draft', user, { note: 'All questions answered' });
    return orderId;
  });
}

export async function submitOrder(orderId, user) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status === 'submitted') return orderId; // idempotent
    if (order.status === 'needs_clarification') throw conflict('Please answer the open questions first.');
    const { rows: items } = await client.query(
      `select i.*, p.active, p.price, p.unit as p_unit, p.pack_size from order_items i left join products p on p.id = i.product_id
       where i.order_id = $1`, [orderId]);
    if (!items.length) throw conflict('Add at least one item before submitting.');
    const bad = items.find((i) => !i.product_id || !i.active);
    if (bad) throw conflict(`"${bad.name}" is not available. Remove or replace it.`);
    // Lock in the current price at submission.
    await client.query(
      `update order_items i set unit_price = p.price from products p where p.id = i.product_id and i.order_id = $1`, [orderId]);
    await recomputeSubtotal(client, orderId);
    await transition(client, order, 'submitted', user);
    return orderId;
  });
}

export async function approveOrder(orderId, user, note) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status === 'approved') return { orderId, warnings: [] };
    const { rows: short } = await client.query(
      `select i.name, i.quantity, p.stock_qty from order_items i join products p on p.id = i.product_id
       where i.order_id = $1 and p.stock_qty < i.quantity`, [orderId]);
    await transition(client, order, 'approved', user, { note, set: { approved_by: user.id, approved_at: new Date() } });
    return { orderId, warnings: short.map((s) => `${s.name}: ${s.quantity} ordered, ${s.stock_qty} in stock`) };
  });
}

export async function rejectOrder(orderId, user, reason) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    await transition(client, order, 'rejected', user, { note: reason, set: { rejected_reason: reason } });
    return orderId;
  });
}

export async function cancelOrder(orderId, user, reason) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status === 'cancelled') return orderId;
    await transition(client, order, 'cancelled', user, { note: reason || null });
    return orderId;
  });
}

export { round2, EDITABLE };
