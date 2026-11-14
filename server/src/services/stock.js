// The only code path that changes products.stock_qty. Always called inside a
// transaction; writes one stock_movements row per change.
import { conflict, notFound } from '../middleware/error.js';

/**
 * @param client  pg client inside a transaction
 * @param m { productId, type: 'inward'|'sale'|'adjustment'|'return', quantity (signed),
 *            unitCost?, refType?, refId?, note?, userId? }
 * @returns updated product row
 */
export async function applyMovement(client, m) {
  if (!m.quantity || !Number.isFinite(m.quantity)) throw new Error('Stock movement quantity must be non-zero.');
  if (m.type === 'sale' && m.quantity > 0) throw new Error('Sale movements must be negative.');
  if (m.type === 'inward' && m.quantity < 0) throw new Error('Inward movements must be positive.');

  // Conditional update keeps stock from going negative even under concurrency.
  const { rows } = await client.query(
    `update products set stock_qty = stock_qty + $2, updated_at = now()
     where id = $1 and stock_qty + $2 >= 0
     returning id, sku, name, stock_qty`,
    [m.productId, m.quantity],
  );
  if (!rows[0]) {
    const p = await client.query('select sku, name, stock_qty from products where id = $1', [m.productId]);
    if (!p.rows[0]) throw notFound('Product not found.');
    const { sku, name, stock_qty } = p.rows[0];
    throw conflict(`Not enough stock for ${name} (${sku}): ${stock_qty} available, ${Math.abs(m.quantity)} needed.`, {
      sku, available: stock_qty, needed: Math.abs(m.quantity),
    });
  }
  await client.query(
    `insert into stock_movements (product_id, type, quantity, unit_cost, ref_type, ref_id, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.productId, m.type, m.quantity, m.unitCost ?? null, m.refType ?? null, m.refId ?? null, m.note ?? null, m.userId ?? null],
  );
  return rows[0];
}
