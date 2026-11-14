import { z } from 'zod';

export const loginBody = z.strictObject({
  phone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, 'Enter a valid phone number.'),
  password: z.string().min(1).max(200),
});
