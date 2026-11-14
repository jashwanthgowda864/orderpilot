// Quantity anomaly check before submit (plain rules, no AI).
// For each line, compare with this customer's past collected/ready orders:
//  - product ordered before: warn if quantity > 3 x their median quantity for it
//  - product never ordered (but the customer has history): warn if quantity >= NEW_PRODUCT_LARGE
//  - customer with no past orders at all: no warnings
import { pool } from '../db.js';
import { getOrderRow } from './orders.js';
import { logAiEvent } from './aiEvents.js';

export const RATIO = 3;
export const NEW_PRODUCT_LARGE = 10;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export async function checkOrderQuantities(orderId, user) {
  const order = await getOrderRow(pool, orderId, user);
  const [{ rows: items }, { rows: history }] = await Promise.all([
    pool.query('select id, product_id, sku, name, quantity from order_items where order_id = $1 and product_id is not null order by position', [orderId]),
    pool.query(
      `select i.product_id, i.quantity from order_items i join orders o on o.id = i.order_id
       where o.customer_id = $1 and o.id <> $2 and o.status in ('collected', 'ready') and i.product_id is not null
         and coalesce(i.origin, '') <> 'substitution'`,
      [order.customer_id, orderId]),
  ]);

  const warnings = [];
  if (history.length) {
    const byProduct = new Map();
    for (const h of history) byProduct.set(h.product_id, [...(byProduct.get(h.product_id) || []), Number(h.quantity)]);
    for (const it of items) {
      const q = Number(it.quantity);
      const past = byProduct.get(it.product_id);
      if (past?.length) {
        const usual = median(past);
        if (q > RATIO * usual) {
          warnings.push({ item_id: it.id, sku: it.sku, name: it.name, quantity: q, usual,
            message: `You usually order ${fmt(usual)} of ${it.name}. Confirm ${fmt(q)}?` });
        }
      } else if (q >= NEW_PRODUCT_LARGE) {
        warnings.push({ item_id: it.id, sku: it.sku, name: it.name, quantity: q, usual: null,
          message: `You haven't ordered ${it.name} before. Confirm ${fmt(q)}?` });
      }
    }
  }

  await logAiEvent({ kind: 'quantity_check', status: 'ok', model: 'rules', userId: user.id, orderId,
    inputSummary: `${items.length} item(s), ${history.length} past line(s)`, output: { warnings } });
  return { warnings, has_history: history.length > 0 };
}
