import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { badRequest } from '../middleware/error.js';
import { ALLOWED_AUDIO_MIME, createUpload } from '../middleware/upload.js';
import { optionalString } from '../validators/common.js';
import { askBusiness } from '../services/insights.js';

const router = Router();
router.use(requireRole('owner'));

const uploadAudio = createUpload(ALLOWED_AUDIO_MIME, 'Only voice audio notes are accepted here.');
const maybeUpload = (req, res, next) => (
  req.is('multipart/form-data') ? uploadAudio.single('file')(req, res, next) : next()
);

const askBody = z.strictObject({
  question: optionalString(z.string().trim().max(500)),
});

router.post('/ask', maybeUpload, validate({ body: askBody }), async (req, res) => {
  const question = req.valid.body.question;
  if (!question && !req.file) throw badRequest('Type a question or record a voice note.');
  const result = await askBusiness({ question, file: req.file, userId: req.user.id });
  res.json(result);
});

export default router;
