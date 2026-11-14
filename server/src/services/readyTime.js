import { config } from '../config.js';
import { PICK_QUEUE } from './rules.js';

export function calculateReadyMinutes({ ownLines, aheadLines = 0, aheadApprovedCount = 0 }) {
  const { setupMinutes, perLineMinutes, pickers } = config.readyTime;
  const raw = (
    setupMinutes
    + perLineMinutes * Math.max(0, ownLines)
    + perLineMinutes * Math.max(0, aheadLines)
    + setupMinutes * Math.max(0, aheadApprovedCount)
  ) / Math.max(1, pickers);
  return Math.max(5, Math.ceil(raw / 5) * 5);
}

/**
 * Recomputes ready estimates for the pick queue inside an active transaction.
 * - For approved orders: includes queue ahead + own unpicked lines.
 * - If `ownOnlyOrderId` is passed (startPicking): computes that picking order
 *   from its own remaining lines only, while updating approved orders behind it.
 */
export async function updateQueueReadyTimes(client, { ownOnlyOrderId = null, onlyOrderId = null } = {}) {
  const { rows: queue } = await client.query(
    `select o.id, o.status, o.approved_at, o.created_at,
            (select count(*)::int from order_items oi where oi.order_id = o.id and oi.pick_status = 'pending') as unpicked_lines
     from orders o
     where o.status = any($1)
     order by o.approved_at asc nulls last, o.created_at asc`,
    [PICK_QUEUE],
  );

  const now = Date.now();
  let aheadLines = 0;
  let aheadApprovedCount = 0;

  for (const q of queue) {
    if (q.id === ownOnlyOrderId) {
      const minutes = calculateReadyMinutes({ ownLines: q.unpicked_lines });
      await client.query(
        `update orders set ready_estimate_minutes = $2, ready_estimate_at = $3 where id = $1`,
        [q.id, minutes, new Date(now + minutes * 60_000)],
      );
    } else if (q.status === 'approved' && (!onlyOrderId || q.id === onlyOrderId)) {
      const minutes = calculateReadyMinutes({
        ownLines: q.unpicked_lines,
        aheadLines,
        aheadApprovedCount,
      });
      await client.query(
        `update orders set ready_estimate_minutes = $2, ready_estimate_at = $3 where id = $1`,
        [q.id, minutes, new Date(now + minutes * 60_000)],
      );
    }
    aheadLines += q.unpicked_lines;
    if (q.status === 'approved') aheadApprovedCount += 1;
  }
}

export async function clearReadyEstimate(client, orderId) {
  await client.query(
    `update orders set ready_estimate_minutes = null, ready_estimate_at = null where id = $1`,
    [orderId],
  );
}
