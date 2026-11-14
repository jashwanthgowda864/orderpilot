// Customer balance changes. Every change writes exactly one customer_ledger row;
// a unique index on (entry_type, ref_id) prevents applying the same invoice or
// payment twice.

/** amount > 0 increases what the customer owes; < 0 reduces it. */
export async function applyLedger(client, { customerId, entryType, amount, refId }) {
  const { rows } = await client.query(
    `update customers set balance = balance + $2, updated_at = now() where id = $1 returning balance`,
    [customerId, amount],
  );
  if (!rows[0]) throw new Error('Customer not found for ledger entry.');
  await client.query(
    `insert into customer_ledger (customer_id, entry_type, amount, ref_id, balance_after)
     values ($1, $2, $3, $4, $5)`,
    [customerId, entryType, amount, refId, rows[0].balance],
  );
  return rows[0].balance;
}
