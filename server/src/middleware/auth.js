import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError } from './error.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/** Verifies the Bearer JWT and loads the (still active) user from the database. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return next(new HttpError(401, 'Your session has expired. Please sign in again.'));
  }
  const { rows } = await query(
    'select id, name, phone, role, customer_id, active from users where id = $1',
    [payload.sub],
  );
  const user = rows[0];
  if (!user || !user.active) return next(new HttpError(401, 'Account not found or disabled.'));
  req.user = user;
  next();
}
