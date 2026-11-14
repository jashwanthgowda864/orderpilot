import { z } from 'zod';

export const uuid = z.uuid({ message: 'Invalid id.' });
export const idParams = z.strictObject({ id: uuid });
export const money = z.number().positive().max(10_000_000).multipleOf(0.01);
export const qty = z.number().positive().max(100_000);
export const idempotencyKey = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const shortText = (max = 500) => z.string().trim().min(1).max(max);
/** Turns '' from forms into undefined. */
export const optionalString = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
export const pagination = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
