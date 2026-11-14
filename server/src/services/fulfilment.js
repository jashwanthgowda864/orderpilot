// Picking, finish-packing and collection.
// Stock and the customer balance change exactly once, at finish-packing, inside
// one transaction (stock movements + invoice + ledger + status).
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../middleware/error.js';
import { getOrderRow } from './orders.js';
import { transition } from './rules.js';
import { applyMovement } from './stock.js';
import { createInvoice } from './invoice.js';
import { recordPayment } from './payments.js';
import { allowsFraction } from './catalogMatch.js';

export async function startPicking(orderId, user) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status === 'picking') return orderId;
    await transition(client, order, 'picking', user, { set: { picking_started_at: new Date() } });
    return orderId;
  });
}

/** Marks one line as packed / short / unavailable while picking. */
export async function pickItem(orderId, itemId, user, { pick_status, packed_qty }) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status !== 'picking') throw conflict('Start picking before marking items.');
    const { rows } = await client.query(
      `select i.*, p.unit as p_unit, p.pack_size from order_items i left join products p on p.id = i.product_id
       where i.id = $1 and i.order_id = $2`, [itemId, orderId]);
    const item = rows[0];
    if (!item) throw notFound('Item not found on this order.');
    const ordered = Number(item.quantity);
    let qty;
    if (pick_status === 'packed') qty = packed_qty ?? ordered;
    else if (pick_status === 'unavailable') qty = 0;
    else if (pick_status === 'short') {
      if (packed_qty == null) throw badRequest('Enter how many were packed.');
      qty = packed_qty;
    } else qty = null; // back to pending
    if (qty != null) {
      if (qty > ordered) throw badRequest(`Cannot pack more than ordered (${ordered}).`);
      if (pick_status === 'packed' && qty !== ordered) throw badRequest('Use "short" when packing less than ordered.');
      if (pick_status === 'short' && (qty <= 0 || qty >= ordered)) throw badRequest('Short quantity must be more than 0 and less than ordered.');
      if (!allowsFraction({ unit: item.p_unit, pack_size: item.pack_size }) && !Number.isInteger(qty)) throw badRequest('Whole packs only.');
    }
    await client.query('update order_items set pick_status = $2, packed_qty = $3 where id = $1', [itemId, pick_status, qty]);
    return orderId;
  });
}

/**
 * Finish packing: picking -> ready. Deducts stock for what was packed, creates
 * the invoice and adds it to the customer's balance. Safe to call twice: a
 * second call on a ready order returns the existing invoice without changes.
 */
export async function finishPacking(orderId, user, { pack_remaining = false } = {}) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (['ready', 'collected'].includes(order.status)) {
      const inv = await client.query('select * from invoices where order_id = $1', [orderId]);
      return { orderId, invoice: inv.rows[0], duplicate: true };
    }
    if (order.status !== 'picking') throw conflict('Start picking before finishing packing.');

    if (pack_remaining) {
      await client.query(
        `update order_items set pick_status = 'packed', packed_qty = quantity where order_id = $1 and pick_status = 'pending'`,
        [orderId]);
    }
    const { rows: items } = await client.query('select * from order_items where order_id = $1 order by position', [orderId]);
    const pending = items.filter((i) => i.pick_status === 'pending');
    if (pending.length) {
      throw conflict(`${pending.length} item(s) not picked yet.`, { pending: pending.map((i) => i.name) });
    }
    const packed = items.filter((i) => Number(i.packed_qty) > 0);
    if (!packed.length) throw conflict('Nothing was packed. Cancel the order instead.');

    for (const i of packed) {
      await applyMovement(client, {
        productId: i.product_id, type: 'sale', quantity: -Number(i.packed_qty),
        refType: 'order_item', refId: i.id, note: `Order #${order.order_no}`, userId: user.id,
      });
    }
    const invoice = await createInvoice(client, order, items);
    await transition(client, order, 'ready', user, { set: { ready_at: new Date() } });
    return { orderId, invoice, duplicate: false };
  });
}

/** Customer collects; optionally take a payment in the same transaction. */
export async function collectOrder(orderId, user, { payment } = {}) {
  return withTransaction(async (client) => {
    const order = await getOrderRow(client, orderId, user, { lock: true });
    if (order.status === 'collected') return { orderId, duplicate: true };
    await transition(client, order, 'collected', user, { set: { collected_at: new Date() } });
    let pay = null;
    if (payment) {
      pay = (await recordPayment(client, {
        customerId: order.customer_id, amount: payment.amount, method: payment.method,
        reference: payment.reference, note: `At collection of order #${order.order_no}`,
        idempotencyKey: payment.idempotency_key, userId: user.id,
      })).payment;
    }
    return { orderId, payment: pay, duplicate: false };
  });
}
