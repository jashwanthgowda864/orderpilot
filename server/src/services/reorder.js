import { pool, withTransaction } from '../db.js';
import { badRequest, notFound } from '../middleware/error.js';
import { allowsFraction } from './catalogMatch.js';
import { recordInitialStatus } from './rules.js';
import { findByIdempotencyKey, insertItems, loadCatalog, recomputeSubtotal, resolveCustomerId } from './orders.js';

const DAY_MS = 86_400_000;
const OPEN_STATUSES = ['needs_clarification', 'draft', 'submitted', 'approved', 'picking'];

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeForCustomer({ historyRows, openProductIds, dismissalMap, catalogById, nowMs }) {
  const byProd = new Map();
  for (const row of historyRows) {
    let list = byProd.get(row.product_id);
    if (!list) { list = []; byProd.set(row.product_id, list); }
    list.push({ createdAt: new Date(row.created_at), quantity: Number(row.quantity) });
  }

  const suggestions = [];
  for (const [productId, entries] of byProd) {
    if (entries.length < 3) continue;
    const product = catalogById.get(productId);
    if (!product || openProductIds.has(productId)) continue;

    const lastOrderAt = entries[entries.length - 1].createdAt;
    const dismissedAt = dismissalMap.get(productId);
    if (dismissedAt && dismissedAt >= lastOrderAt) continue;

    const gaps = [];
    for (let i = 1; i < entries.length; i++) {
      gaps.push((entries[i].createdAt.getTime() - entries[i - 1].createdAt.getTime()) / DAY_MS);
    }
    const medGap = median(gaps);
    if (!(medGap > 0)) continue;

    const daysSince = (nowMs - lastOrderAt.getTime()) / DAY_MS;
    if (daysSince < 0.9 * medGap) continue;

    const medQty = median(entries.map((e) => e.quantity));
    const suggestedQty = allowsFraction(product)
      ? Math.max(0.001, Math.round(medQty * 1000) / 1000)
      : Math.max(1, Math.round(medQty));

    suggestions.push({
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      pack_size: Number(product.pack_size),
      price: Number(product.price),
      in_stock: Number(product.stock_qty) > 0,
      suggested_quantity: suggestedQty,
      median_gap_days: Math.round(medGap * 10) / 10,
      days_since_last: Math.round(daysSince * 10) / 10,
      order_count: entries.length,
      last_ordered_at: lastOrderAt,
    });
  }

  return suggestions.sort((a, b) => (b.days_since_last / b.median_gap_days) - (a.days_since_last / a.median_gap_days));
}

export async function getReorderSuggestions(customerId, db = pool) {
  const [catalog, historyRes, openRes, dismissRes] = await Promise.all([
    loadCatalog(db),
    db.query(
      `select o.id as order_id, o.created_at, oi.product_id, sum(oi.quantity) as quantity
       from orders o
       join order_items oi on oi.order_id = o.id
       where o.customer_id = $1
         and o.status in ('collected', 'ready')
         and oi.product_id is not null
         and coalesce(oi.origin, '') <> 'substitution'
       group by o.id, o.created_at, oi.product_id
       order by o.created_at asc`,
      [customerId],
    ),
    db.query(
      `select distinct oi.product_id
       from orders o
       join order_items oi on oi.order_id = o.id
       where o.customer_id = $1 and o.status = any($2) and oi.product_id is not null`,
      [customerId, OPEN_STATUSES],
    ),
    db.query(
      `select product_id, dismissed_at from reorder_nudge_dismissals where customer_id = $1`,
      [customerId],
    ),
  ]);

  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  const openProductIds = new Set(openRes.rows.map((r) => r.product_id));
  const dismissalMap = new Map(dismissRes.rows.map((r) => [r.product_id, new Date(r.dismissed_at)]));

  return computeForCustomer({
    historyRows: historyRes.rows,
    openProductIds,
    dismissalMap,
    catalogById,
    nowMs: Date.now(),
  });
}

export async function getDueCustomers(db = pool) {
  const [catalog, custRes, historyRes, openRes, dismissRes] = await Promise.all([
    loadCatalog(db),
    db.query(`select id, name, phone from customers where active order by name`),
    db.query(
      `select o.customer_id, o.id as order_id, o.created_at, oi.product_id, sum(oi.quantity) as quantity
       from orders o
       join order_items oi on oi.order_id = o.id
       where o.status in ('collected', 'ready')
         and oi.product_id is not null
         and coalesce(oi.origin, '') <> 'substitution'
       group by o.customer_id, o.id, o.created_at, oi.product_id
       order by o.created_at asc`,
    ),
    db.query(
      `select distinct o.customer_id, oi.product_id
       from orders o
       join order_items oi on oi.order_id = o.id
       where o.status = any($1) and oi.product_id is not null`,
      [OPEN_STATUSES],
    ),
    db.query(`select customer_id, product_id, dismissed_at from reorder_nudge_dismissals`),
  ]);

  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  const historyByCust = new Map();
  for (const r of historyRes.rows) {
    let arr = historyByCust.get(r.customer_id);
    if (!arr) { arr = []; historyByCust.set(r.customer_id, arr); }
    arr.push(r);
  }
  const openByCust = new Map();
  for (const r of openRes.rows) {
    let set = openByCust.get(r.customer_id);
    if (!set) { set = new Set(); openByCust.set(r.customer_id, set); }
    set.add(r.product_id);
  }
  const dismissByCust = new Map();
  for (const r of dismissRes.rows) {
    let map = dismissByCust.get(r.customer_id);
    if (!map) { map = new Map(); dismissByCust.set(r.customer_id, map); }
    map.set(r.product_id, new Date(r.dismissed_at));
  }

  const nowMs = Date.now();
  const due = [];
  for (const c of custRes.rows) {
    const suggestions = computeForCustomer({
      historyRows: historyByCust.get(c.id) || [],
      openProductIds: openByCust.get(c.id) || new Set(),
      dismissalMap: dismissByCust.get(c.id) || new Map(),
      catalogById,
      nowMs,
    });
    if (suggestions.length) {
      due.push({ customer_id: c.id, customer_name: c.name, phone: c.phone, suggestions });
    }
  }
  return due;
}

export async function createReorderDraft({ user, customerId, items, idempotencyKey }) {
  const existing = await findByIdempotencyKey(idempotencyKey, user);
  if (existing) return { orderId: existing, duplicate: true };

  const custId = await resolveCustomerId(user, customerId);
  const catalog = await loadCatalog();
  const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));

  const merged = new Map();
  for (const it of items) {
    const p = bySku.get(it.sku.toLowerCase());
    if (!p) throw badRequest(`Unknown or inactive product ${it.sku}.`);
    const prev = merged.get(p.sku);
    const totalQty = (prev ? prev.quantity : 0) + Number(it.quantity);
    if (!allowsFraction(p) && !Number.isInteger(totalQty)) {
      throw badRequest(`${p.name} must be ordered in whole packs.`);
    }
    merged.set(p.sku, {
      product: p,
      name: p.name,
      quantity: totalQty,
      unit: p.unit,
      confidence: null,
      origin: 'previous_order',
      source_text: null,
      questions: [],
    });
  }

  try {
    const orderId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into orders (customer_id, created_by, channel, status, idempotency_key)
         values ($1, $2, 'nudge', 'draft', $3) returning id`,
        [custId, user.id, idempotencyKey || null],
      );
      const id = rows[0].id;
      await insertItems(client, id, [...merged.values()]);
      await recomputeSubtotal(client, id);
      await recordInitialStatus(client, id, 'draft', user.id, 'reorder nudge');
      return id;
    });
    return { orderId, duplicate: false };
  } catch (err) {
    if (err.code === '23505' && idempotencyKey) {
      const id = await findByIdempotencyKey(idempotencyKey, user);
      if (id) return { orderId: id, duplicate: true };
    }
    throw err;
  }
}

export async function dismissReorderSuggestion({ customerId, productId }) {
  const { rows } = await pool.query('select id from products where id = $1', [productId]);
  if (!rows[0]) throw notFound('Product not found.');
  await pool.query(
    `insert into reorder_nudge_dismissals (customer_id, product_id, dismissed_at)
     values ($1, $2, now())
     on conflict (customer_id, product_id) do update set dismissed_at = now()`,
    [customerId, productId],
  );
}
