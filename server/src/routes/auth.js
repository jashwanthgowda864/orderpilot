import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loginBody } from '../validators/auth.js';

const router = Router();
// Equal-time comparison even when the phone is unknown.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/login', validate({ body: loginBody }), async (req, res) => {
  const { phone, password } = req.valid.body;
  const { rows } = await query(
    'select id, name, phone, role, customer_id, active, password_hash from users where phone = $1', [phone]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
  if (!u || !ok || !u.active) throw new HttpError(401, 'Phone number or password is incorrect.');
  const { password_hash, ...user } = u;
  res.json({ token: signToken(user), user });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

export default router;
