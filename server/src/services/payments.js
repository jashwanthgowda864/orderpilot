import { conflict, notFound } from '../middleware/error.js';
import { applyLedger } from './ledger.js';

/**
 * Records a payment and reduces the customer's balance, inside the caller's
 * transaction. Re-sending the same idempotency key returns the original payment.
 */
export async function recordPayment(client, { customerId, amount, method, reference, note, idempotencyKey, userId }) {
  if (idempotencyKey) {
    const existing = await client.query('select * from payments where idempotency_key = $1', [idempotencyKey]);
    if (existing.rows[0]) {
      const p = existing.rows[0];
      if (p.customer_id !== customerId || Number(p.amount) !== Number(amount)) {
        throw conflict('This idempotency key was already used for a different payment.');
      }
      return { payment: p, duplicate: true };
    }
  }
  const c = await client.query('select id from customers where id = $1 for update', [customerId]);
  if (!c.rows[0]) throw notFound('Customer not found.');
  const { rows } = await client.query(
    `insert into payments (customer_id, amount, method, reference, note, idempotency_key, received_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [customerId, amount, method, reference ?? null, note ?? null, idempotencyKey ?? null, userId ?? null],
  );
  await applyLedger(client, { customerId, entryType: 'payment', amount: -amount, refId: rows[0].id });
  return { payment: rows[0], duplicate: false };
}
