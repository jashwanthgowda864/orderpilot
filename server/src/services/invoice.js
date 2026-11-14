// Invoices are created exactly once per order, at finish-packing, from what was
// actually packed. A unique index on invoices.order_id enforces "once".
import { applyLedger } from './ledger.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function buildInvoiceLines(items) {
  return items
    .filter((i) => Number(i.packed_qty) > 0)
    .map((i) => ({
      item_id: i.id,
      sku: i.sku,
      name: i.name,
      quantity: Number(i.packed_qty),
      ordered_quantity: Number(i.quantity),
      unit: i.unit,
      unit_price: Number(i.unit_price),
      line_total: round2(Number(i.packed_qty) * Number(i.unit_price)),
      ...(i.substitutes_sku ? { substitutes_sku: i.substitutes_sku } : {}),
    }));
}

export async function createInvoice(client, order, items) {
  const existing = await client.query('select * from invoices where order_id = $1', [order.id]);
  if (existing.rows[0]) return existing.rows[0];

  const { rows: s } = await client.query('select tax_rate from shop_settings where id = 1');
  const taxRate = Number(s[0]?.tax_rate || 0);
  const lines = buildInvoiceLines(items);
  const subtotal = round2(lines.reduce((sum, l) => sum + l.line_total, 0));
  const tax = round2((subtotal * taxRate) / 100);
  const total = round2(subtotal + tax);

  const { rows } = await client.query(
    `insert into invoices (order_id, customer_id, lines, subtotal, tax, total)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [order.id, order.customer_id, JSON.stringify(lines), subtotal, tax, total],
  );
  await applyLedger(client, { customerId: order.customer_id, entryType: 'invoice', amount: total, refId: rows[0].id });
  return rows[0];
}
