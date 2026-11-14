import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { ALLOWED_IMAGE_MIME, createUpload, sniffImage } from '../middleware/upload.js';
import { badRequest } from '../middleware/error.js';
import { idParams, pagination, qty, uuid } from '../validators/common.js';
import { getFile } from '../services/storage.js';
import {
  applySupplierBill,
  discardSupplierBill,
  formatBillDetail,
  getSupplierBillRow,
  listSupplierBills,
  scanSupplierBill,
} from '../services/supplierBills.js';

const router = Router();
router.use(requireRole('owner'));

const uploadImage = createUpload(ALLOWED_IMAGE_MIME, 'Only photos (JPG, PNG, WEBP, HEIC) are accepted.');

const emptyToNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema);

const applyBody = z.strictObject({
  supplier_name: emptyToNull(z.string().trim().max(200).nullable()).optional(),
  bill_number: emptyToNull(z.string().trim().max(100).nullable()).optional(),
  bill_date: emptyToNull(z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD date format.').nullable()).optional(),
  confirm_duplicate_date: z.boolean().optional(),
  lines: z.array(z.strictObject({
    product_id: emptyToNull(uuid.nullable()).optional(),
    packs: emptyToNull(qty.nullable()).optional(),
    unit_cost: emptyToNull(z.number().min(0).max(10_000_000).nullable()).optional(),
    skip: z.boolean().default(false),
  })).min(1).max(200),
});

router.get('/', validate({ query: z.strictObject(pagination) }), async (req, res) => {
  res.json({ bills: await listSupplierBills(req.valid.query) });
});

router.post('/scan', uploadImage.single('file'), async (req, res) => {
  sniffImage(req.file);
  const bill = await scanSupplierBill({ file: req.file, user: req.user });
  res.status(201).json({ bill });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const row = await getSupplierBillRow(req.valid.params.id);
  res.json({ bill: await formatBillDetail(row) });
});

router.get('/:id/file', validate({ params: idParams }), async (req, res) => {
  const row = await getSupplierBillRow(req.valid.params.id);
  if (!row.file_path) throw badRequest('This bill has no attached photo.');
  const f = await getFile(row.file_path);
  if (f.url) return res.json({ url: f.url });
  res.set('content-type', f.contentType).set('cache-control', 'private, no-store').send(f.buffer);
});

router.post('/:id/apply', validate({ params: idParams, body: applyBody }), async (req, res) => {
  const bill = await applySupplierBill(req.valid.params.id, req.user, req.valid.body);
  res.json({ bill });
});

router.post('/:id/discard', validate({ params: idParams }), async (req, res) => {
  const bill = await discardSupplierBill(req.valid.params.id);
  res.json({ bill });
});

export default router;
