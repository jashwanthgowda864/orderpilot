import { forbidden } from './error.js';

/** requireRole('owner', 'staff') — must run after requireAuth. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const isStaffOrOwner = (user) => user.role === 'staff' || user.role === 'owner';

/** Customers may only touch their own customer record. */
export function assertCustomerAccess(user, customerId) {
  if (user.role === 'customer' && user.customer_id !== customerId) throw forbidden();
}
