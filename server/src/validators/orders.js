import { z } from 'zod';
import { uuid, qty, idempotencyKey, shortText, optionalString, pagination, money } from './common.js';
import { STATUSES } from '../services/rules.js';

export const listOrdersQuery = z.strictObject({
  status: optionalString(z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(STATUSES)).max(STATUSES.length))),
  customer_id: optionalString(uuid),
  ...pagination,
});

// multipart/form-data fields (all strings)
export const parseOrderBody = z.strictObject({
  text: optionalString(z.string().trim().max(5000)),
  customer_id: optionalString(uuid),
  idempotency_key: optionalString(idempotencyKey),
  notes: optionalString(z.string().trim().max(1000)),
});

const skuItem = z.strictObject({ sku: z.string().trim().min(1).max(64), quantity: qty });

export const manualOrderBody = z.strictObject({
  customer_id: uuid,
  items: z.array(skuItem).min(1).max(100),
  notes: z.string().trim().max(1000).optional(),
  idempotency_key: idempotencyKey.optional(),
});

export const updateItemsBody = z.strictObject({
  items: z.array(z.strictObject({ id: uuid.optional(), sku: z.string().trim().min(1).max(64), quantity: qty })).min(1).max(100),
});

export const clarParams = z.strictObject({ id: uuid, clarId: uuid });
export const answerBody = z.strictObject({
  sku: z.string().trim().min(1).max(64).optional(),
  quantity: qty.optional(),
  text: z.string().trim().min(1).max(500).optional(),
  skip: z.boolean().optional(),
}).refine((b) => b.skip || b.sku || b.quantity || b.text, { message: 'Provide an answer or skip.' });

export const noteBody = z.strictObject({ note: z.string().trim().max(500).optional() });
export const reasonBody = z.strictObject({ reason: shortText(500) });
export const optionalReasonBody = z.strictObject({ reason: z.string().trim().max(500).optional() });

export const itemParams = z.strictObject({ id: uuid, itemId: uuid });
export const subParams = z.strictObject({ id: uuid, subId: uuid });
export const pickBody = z.strictObject({
  pick_status: z.enum(['pending', 'packed', 'short', 'unavailable']),
  packed_qty: z.number().min(0).max(100_000).optional(),
});
export const finishPackingBody = z.strictObject({
  pack_remaining: z.boolean().optional(),
  proceed_without_substitutes: z.boolean().optional(),
});
export const collectBody = z.strictObject({
  payment: z.strictObject({
    amount: money,
    method: z.enum(['cash', 'upi', 'card', 'other']),
    reference: z.string().trim().max(100).optional(),
    idempotency_key: idempotencyKey.optional(),
  }).optional(),
});
