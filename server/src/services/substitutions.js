import { pool, withTransaction } from '../db.js';
import { conflict, notFound } from '../middleware/error.js';
import { baseSizeOfProduct, convertPacks } from './catalogMatch.js';
import { rankSubstitutes } from './gemini.js';
import { getOrderRow, recomputeSubtotal } from './orders.js';

function defaultReason(cand, quantity, exact) {
  const pack = `${Number(cand.pack_size)} ${cand.unit}`;
  return exact
    ? `Same quantity (${quantity} × ${pack}) in ${cand.substitute_group}`
    : `Alternative (${quantity} × ${pack}) in ${cand.substitute_group}`;
}

/**
 * Finds eligible active substitute candidates in the same `substitute_group`
 * and unit family with enough stock to cover `shortfallPacks`, sorted deterministically:
 * exact multiples first, then closest price per base unit.
 */
export async function computeCandidates(db, { orderId, itemId, shortfallPacks }) {
  if (!(shortfallPacks > 0)) return { item: null, candidates: [] };
  const { rows: itemRows } = await db.query(
    `select oi.*, p.id as p_id, p.sku as p_sku, p.name as p_name, p.unit as p_unit,
            p.pack_size as p_pack_size, p.price as p_price, p.substitute_group
     from order_items oi
     left join products p on p.id = oi.product_id
     where oi.id = $1 and oi.order_id = $2`,
    [itemId, orderId],
  );
  const item = itemRows[0];
  if (!item || !item.p_id || !item.substitute_group) return { item, candidates: [] };

  const origProd = {
    id: item.p_id,
    sku: item.p_sku,
    name: item.p_name,
    unit: item.p_unit,
    pack_size: item.p_pack_size,
    price: item.p_price,
    substitute_group: item.substitute_group,
  };
  const origBase = baseSizeOfProduct(origProd);
  if (!origBase || origBase.size <= 0) return { item, candidates: [] };
  const origPricePerBase = Number(origProd.price) / origBase.size;

  const [candRes, declinedRes] = await Promise.all([
    db.query(
      `select id, sku, name, category, unit, pack_size, price, stock_qty, substitute_group
       from products
       where active and substitute_group = $1 and id <> $2 and stock_qty > 0`,
      [origProd.substitute_group, origProd.id],
    ),
    db.query(
      `select product_id from substitution_suggestions where original_item_id = $1 and status = 'declined'`,
      [itemId],
    ),
  ]);
  const declinedIds = new Set(declinedRes.rows.map((r) => r.product_id));

  const eligible = [];
  for (const cand of candRes.rows) {
    if (declinedIds.has(cand.id)) continue;
    const conv = convertPacks(shortfallPacks, origProd, cand);
    if (!conv) continue;
    if (Number(cand.stock_qty) < conv.quantity) continue;
    const candBase = baseSizeOfProduct(cand);
    const candPricePerBase = candBase && candBase.size > 0 ? Number(cand.price) / candBase.size : Number(cand.price);
    eligible.push({
      cand,
      quantity: conv.quantity,
      exact: conv.exact,
      priceDiff: Math.abs(candPricePerBase - origPricePerBase),
      reason: defaultReason(cand, conv.quantity, conv.exact),
    });
  }

  eligible.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (Math.abs(a.priceDiff - b.priceDiff) > 1e-6) return a.priceDiff - b.priceDiff;
    return a.cand.sku.localeCompare(b.cand.sku);
  });

  return { item, candidates: eligible };
}

/**
 * Optional Gemini tie-breaker called OUTSIDE any DB lock when >2 candidates qualify.
 * Never throws; any AI error silently falls back to deterministic ordering.
 */
export async function maybeRankWithAi({ orderId, itemId, shortfallPacks, userId }) {
  const { item, candidates } = await computeCandidates(pool, { orderId, itemId, shortfallPacks });
  if (candidates.length <= 2) return null;
  try {
    const res = await rankSubstitutes({
      originalName: item.p_name || item.name,
      shortfall: shortfallPacks,
      unit: item.p_unit || item.unit,
      candidates: candidates.slice(0, 6),
      userId,
      orderId,
    });
    return res.picks;
  } catch {
    return null;
  }
}

export async function expirePendingForItem(client, itemId, userId = null) {
  await client.query(
    `update substitution_suggestions
     set status = 'expired', decided_by = coalesce(decided_by, $2), decided_at = coalesce(decided_at, now())
     where original_item_id = $1 and status = 'pending'`,
    [itemId, userId],
  );
}

export async function saveSuggestionsForItem(client, { orderId, itemId, shortfallPacks, aiPicks = null }) {
  // Never overwrite an already-accepted substitute for this item.
  const accepted = await client.query(
    `select 1 from substitution_suggestions where original_item_id = $1 and status = 'accepted' limit 1`,
    [itemId],
  );
  if (accepted.rows[0]) return [];

  await client.query(
    `delete from substitution_suggestions where original_item_id = $1 and status in ('pending', 'expired')`,
    [itemId],
  );

  const { candidates } = await computeCandidates(client, { orderId, itemId, shortfallPacks });
  if (!candidates.length) return [];

  let chosen = [];
  if (aiPicks?.length && candidates.length > 2) {
    const bySku = new Map(candidates.map((c) => [c.cand.sku.toLowerCase(), c]));
    const seen = new Set();
    for (const pick of aiPicks) {
      const match = bySku.get(String(pick.sku || '').toLowerCase());
      if (match && !seen.has(match.cand.id)) {
        seen.add(match.cand.id);
        chosen.push({ ...match, reason: pick.reason || match.reason });
      }
    }
    for (const c of candidates) {
      if (chosen.length >= 2) break;
      if (!seen.has(c.cand.id)) { seen.add(c.cand.id); chosen.push(c); }
    }
    chosen = chosen.slice(0, 2);
  } else {
    chosen = candidates.slice(0, 2);
  }

  const inserted = [];
  for (const [idx, c] of chosen.entries()) {
    const { rows } = await client.query(
      `insert into substitution_suggestions (order_id, original_item_id, product_id, quantity, rank, reason, status)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       returning *`,
      [orderId, itemId, c.cand.id, c.quantity, idx + 1, c.reason],
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

export async function acceptSubstitution(orderId, subId, user) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    const { rows: subRows } = await client.query(
      `select * from substitution_suggestions where id = $1 and order_id = $2 for update`,
      [subId, orderId],
    );
    const sub = subRows[0];
    if (!sub) throw notFound('Substitution offer not found.');
    if (sub.status === 'accepted') return { orderId, duplicate: true };
    if (order.status !== 'picking') throw conflict('Substitutions can only be accepted while the order is being packed.');
    if (sub.status !== 'pending') throw conflict(`This substitution offer is already ${sub.status}.`);

    const alreadyAccepted = await client.query(
      `select 1 from substitution_suggestions where original_item_id = $1 and status = 'accepted' and id <> $2 limit 1`,
      [sub.original_item_id, sub.id],
    );
    if (alreadyAccepted.rows[0]) throw conflict('Another substitute was already accepted for this item.');

    const { rows: prodRows } = await client.query(
      `select id, sku, name, unit, price, stock_qty, active from products where id = $1 for update`,
      [sub.product_id],
    );
    const p = prodRows[0];
    if (!p || !p.active || Number(p.stock_qty) < Number(sub.quantity)) {
      throw conflict('This substitute is no longer available.');
    }

    const { rows: posRows } = await client.query(
      `select coalesce(max(position), -1)::int + 1 as next_pos from order_items where order_id = $1`,
      [orderId],
    );
    const { rows: createdRows } = await client.query(
      `insert into order_items (order_id, position, product_id, sku, name, quantity, unit, unit_price, confidence, origin, substitutes_item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, null, 'substitution', $9)
       returning *`,
      [orderId, posRows[0].next_pos, p.id, p.sku, p.name, sub.quantity, p.unit, p.price, sub.original_item_id],
    );

    await client.query(
      `update substitution_suggestions
       set status = 'accepted', decided_by = $2, decided_at = now(), created_item_id = $3
       where id = $1`,
      [sub.id, user.id, createdRows[0].id],
    );
    await client.query(
      `update substitution_suggestions
       set status = 'expired', decided_by = $3, decided_at = now()
       where original_item_id = $1 and id <> $2 and status = 'pending'`,
      [sub.original_item_id, sub.id, user.id],
    );
    await recomputeSubtotal(client, orderId);
    return { orderId, duplicate: false };
  });
}

export async function declineSubstitution(orderId, subId, user) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    const { rows: subRows } = await client.query(
      `select * from substitution_suggestions where id = $1 and order_id = $2 for update`,
      [subId, orderId],
    );
    const sub = subRows[0];
    if (!sub) throw notFound('Substitution offer not found.');
    if (sub.status === 'declined') return { orderId, duplicate: true };
    if (order.status !== 'picking') throw conflict('Substitutions can only be declined while the order is being packed.');
    if (sub.status !== 'pending') throw conflict(`This substitution offer is already ${sub.status}.`);

    await client.query(
      `update substitution_suggestions set status = 'declined', decided_by = $2, decided_at = now() where id = $1`,
      [sub.id, user.id],
    );
    return { orderId, duplicate: false };
  });
}
