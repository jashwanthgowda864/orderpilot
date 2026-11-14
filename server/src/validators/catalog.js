import { z } from 'zod';
import { uuid, idempotencyKey, money, optionalString, pagination } from './common.js';

const unit = z.enum(['kg', 'g', 'l', 'ml', 'pcs', 'pack']);
const productFields = {
  sku: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9_-]+$/, 'SKU may contain letters, numbers, - and _.'),
  name: z.string().trim().min(1).max(200),
  name_kn: z.string().trim().max(200).nullable(),
  name_hi: z.string().trim().max(200).nullable(),
  aliases: z.array(z.string().trim().min(1).max(100)).max(30),
  category: z.string().trim().min(1).max(100),
  unit,
  pack_size: z.number().positive().max(100000),
  price: z.number().min(0).max(10_000_000).multipleOf(0.01),
  reorder_level: z.number().min(0).max(100000),
  active: z.boolean(),
};
export const createProductBody = z.strictObject({
  ...productFields,
  name_kn: productFields.name_kn.optional(),
  name_hi: productFields.name_hi.optional(),
  aliases: productFields.aliases.default([]),
  reorder_level: productFields.reorder_level.default(0),
  active: productFields.active.default(true),
  opening_stock: z.number().min(0).max(1_000_000).default(0),
});
const { sku, ...editable } = productFields;
export const updateProductBody = z.strictObject(
  Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])),
).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

export const stockMovementBody = z.strictObject({
  product_id: uuid,
  type: z.enum(['inward', 'adjustment']),
  quantity: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'Quantity must be non-zero.'),
  unit_cost: z.number().min(0).max(10_000_000).optional(),
  note: z.string().trim().max(500).optional(),
});
export const stockQuery = z.strictObject({ product_id: optionalString(uuid), ...pagination });

export const customerQuery = z.strictObject({ q: optionalString(z.string().trim().max(100)), ...pagination });
export const createCustomerBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, 'Enter a valid phone number.'),
  preferred_language: z.enum(['en', 'kn', 'hi']).nullable().optional(),
  address: z.string().trim().max(500).optional(),
  credit_limit: z.number().min(0).max(10_000_000).default(0),
  password: z.string().min(8).max(200).optional(), // creates a customer login when given
});
export const updateCustomerBody = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  preferred_language: z.enum(['en', 'kn', 'hi']).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  credit_limit: z.number().min(0).max(10_000_000).optional(),
  active: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

export const paymentBody = z.strictObject({
  customer_id: uuid,
  amount: money,
  method: z.enum(['cash', 'upi', 'card', 'other']),
  reference: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
  idempotency_key: idempotencyKey.optional(),
});
export const paymentQuery = z.strictObject({ customer_id: optionalString(uuid), ...pagination });

export const shopBody = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  tax_rate: z.number().min(0).max(100).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });
