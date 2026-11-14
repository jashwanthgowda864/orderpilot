// Order lifecycle rules. This is the single source of truth for which status
// changes are allowed and who may make them.
import { conflict, forbidden } from '../middleware/error.js';

export const STATUSES = [
  'needs_clarification', 'draft', 'submitted', 'approved', 'picking',
  'ready', 'collected', 'rejected', 'cancelled',
];

// from -> { to: [roles allowed] }
const TRANSITIONS = {
  needs_clarification: { draft: ['customer', 'staff', 'owner'], cancelled: ['customer', 'staff', 'owner'] },
  draft:               { submitted: ['customer', 'staff', 'owner'], cancelled: ['customer', 'staff', 'owner'] },
  submitted:           { approved: ['staff', 'owner'], rejected: ['staff', 'owner'], cancelled: ['customer', 'staff', 'owner'] },
  approved:            { picking: ['staff', 'owner'], cancelled: ['staff', 'owner'] },
  picking:             { ready: ['staff', 'owner'], cancelled: ['staff', 'owner'] },
  ready:               { collected: ['staff', 'owner'] },
  collected: {}, rejected: {}, cancelled: {},
};

export const TERMINAL = new Set(['collected', 'rejected', 'cancelled']);
/** Statuses in which the order's items can still be edited by the customer/staff. */
export const EDITABLE = new Set(['needs_clarification', 'draft']);
/** Orders waiting in the pick queue. */
export const PICK_QUEUE = ['approved', 'picking'];

export function canTransition(from, to, role) {
  const roles = TRANSITIONS[from]?.[to];
  return Boolean(roles && roles.includes(role));
}

export function assertTransition(from, to, role) {
  const roles = TRANSITIONS[from]?.[to];
  if (!roles) throw conflict(`Order is ${from.replace('_', ' ')} and cannot be moved to ${to.replace('_', ' ')}.`);
  if (!roles.includes(role)) throw forbidden();
}

export function allowedNext(from, role) {
  return Object.entries(TRANSITIONS[from] || {})
    .filter(([, roles]) => roles.includes(role))
    .map(([to]) => to);
}

/**
 * Applies a status change inside a transaction. Uses a compare-and-set on the
 * current status so concurrent requests cannot both succeed.
 */
export async function transition(client, order, to, user, { note = null, set = {} } = {}) {
  assertTransition(order.status, to, user.role);
  const cols = Object.keys(set);
  const assignments = ['status = $1', 'updated_at = now()', ...cols.map((c, i) => `${c} = $${i + 4}`)];
  const { rows } = await client.query(
    `update orders set ${assignments.join(', ')} where id = $2 and status = $3 returning *`,
    [to, order.id, order.status, ...cols.map((c) => set[c])],
  );
  if (!rows[0]) throw conflict('This order was changed by someone else. Please refresh.');
  await client.query(
    `insert into order_status_history (order_id, from_status, to_status, changed_by, note)
     values ($1, $2, $3, $4, $5)`,
    [order.id, order.status, to, user.id, note],
  );
  return rows[0];
}

export async function recordInitialStatus(client, orderId, status, userId, note = null) {
  await client.query(
    `insert into order_status_history (order_id, from_status, to_status, changed_by, note)
     values ($1, null, $2, $3, $4)`,
    [orderId, status, userId, note],
  );
}
