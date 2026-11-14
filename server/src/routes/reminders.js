import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { uuid } from '../validators/common.js';
import { createReminderDraft } from '../services/reminders.js';

const router = Router();
router.use(requireRole('owner'));

const draftBody = z.strictObject({ customer_id: uuid });

router.post('/draft', validate({ body: draftBody }), async (req, res) => {
  const result = await createReminderDraft({ customerId: req.valid.body.customer_id, userId: req.user.id });
  res.json(result);
});

export default router;
