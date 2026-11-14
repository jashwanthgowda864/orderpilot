import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { idempotencyKey, optionalString, qty, uuid } from '../validators/common.js';
import { getOrderDetail, resolveCustomerId } from '../services/orders.js';
import { createReorderDraft, dismissReorderSuggestion, getDueCustomers, getReorderSuggestions } from '../services/reorder.js';

const router = Router();

const suggestionsQuery = z.strictObject({ customer_id: optionalString(uuid) });
const draftBody = z.strictObject({
  customer_id: optionalString(uuid),
  items: z.array(z.strictObject({ sku: z.string().trim().min(1).max(64), quantity: qty })).min(1).max(100),
  idempotency_key: optionalString(idempotencyKey),
});
const dismissBody = z.strictObject({ product_id: uuid });

router.get('/suggestions', validate({ query: suggestionsQuery }), async (req, res) => {
  const customerId = await resolveCustomerId(req.user, req.valid.query.customer_id);
  res.json({ suggestions: await getReorderSuggestions(customerId) });
});

router.post('/draft', validate({ body: draftBody }), async (req, res) => {
  const b = req.valid.body;
  const { orderId, duplicate } = await createReorderDraft({
    user: req.user,
    customerId: b.customer_id,
    items: b.items,
    idempotencyKey: b.idempotency_key,
  });
  res.status(duplicate ? 200 : 201).json({ order: await getOrderDetail(orderId, req.user), duplicate });
});

router.post('/dismiss', requireRole('customer'), validate({ body: dismissBody }), async (req, res) => {
  await dismissReorderSuggestion({ customerId: req.user.customer_id, productId: req.valid.body.product_id });
  res.json({ ok: true });
});

router.get('/due', requireRole('owner'), async (req, res) => {
  res.json({ due: await getDueCustomers() });
});

export default router;
