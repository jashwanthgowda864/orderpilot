import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { badRequest } from '../middleware/error.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { idParams } from '../validators/common.js';
import * as v from '../validators/orders.js';
import * as orders from '../services/orders.js';
import * as fulfilment from '../services/fulfilment.js';
import { getFile } from '../services/storage.js';
import { PICK_QUEUE } from '../services/rules.js';

const router = Router();
const staff = requireRole('staff', 'owner');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    file.mimetype = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!orders.ALLOWED_MIME.has(file.mimetype)) return cb(badRequest('Only photos (JPG, PNG, WEBP, HEIC) or voice notes are accepted.'));
    cb(null, true);
  },
});

/** Reject files whose bytes don't look like the declared image type. */
function sniffImage(file) {
  if (!file || !file.mimetype.startsWith('image/')) return;
  const b = file.buffer;
  const ok = {
    'image/jpeg': b[0] === 0xff && b[1] === 0xd8,
    'image/png': b.subarray(0, 4).toString('hex') === '89504e47',
    'image/webp': b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    'image/heic': b.subarray(4, 8).toString() === 'ftyp',
    'image/heif': b.subarray(4, 8).toString() === 'ftyp',
  }[file.mimetype];
  if (!ok) throw badRequest('The photo file looks damaged or is not an image.');
}

const detail = async (req, res, id, extra = {}) => res.json({ order: await orders.getOrderDetail(id, req.user), ...extra });

router.get('/', validate({ query: v.listOrdersQuery }), async (req, res) => {
  res.json({ orders: await orders.listOrders(req.user, req.valid.query) });
});

router.get('/pick-queue', staff, async (req, res) => {
  const { rows } = await pool.query(
    `select o.id, o.order_no, o.status, o.approved_at, o.picking_started_at, c.name as customer_name,
            (select count(*)::int from order_items i where i.order_id = o.id) as item_count,
            (select count(*)::int from order_items i where i.order_id = o.id and i.pick_status <> 'pending') as picked_count
     from orders o join customers c on c.id = o.customer_id
     where o.status = any($1) order by o.approved_at nulls last, o.created_at`, [PICK_QUEUE]);
  res.json({ queue: rows });
});

// Text / photo / voice order (customer, or staff in counter mode with customer_id).
router.post('/parse', upload.single('file'), validate({ body: v.parseOrderBody }), async (req, res) => {
  sniffImage(req.file);
  const { text, customer_id, idempotency_key, notes } = req.valid.body;
  const { orderId, duplicate } = await orders.createOrderFromInput({
    user: req.user, customerId: customer_id, text, file: req.file, idempotencyKey: idempotency_key, notes,
  });
  res.status(duplicate ? 200 : 201);
  await detail(req, res, orderId, { duplicate });
});

// Counter order from explicit SKUs (no AI).
router.post('/', staff, validate({ body: v.manualOrderBody }), async (req, res) => {
  const b = req.valid.body;
  const { orderId, duplicate } = await orders.createManualOrder({
    user: req.user, customerId: b.customer_id, items: b.items, notes: b.notes, idempotencyKey: b.idempotency_key,
  });
  res.status(duplicate ? 200 : 201);
  await detail(req, res, orderId, { duplicate });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => detail(req, res, req.valid.params.id));

router.get('/:id/file', validate({ params: idParams }), async (req, res) => {
  const order = await orders.getOrderRow(pool, req.valid.params.id, req.user);
  if (!order.input_file_path) throw badRequest('This order has no attached file.');
  const f = await getFile(order.input_file_path);
  if (f.url) return res.json({ url: f.url });
  res.set('content-type', f.contentType).set('cache-control', 'private, no-store').send(f.buffer);
});

router.put('/:id/items', validate({ params: idParams, body: v.updateItemsBody }), async (req, res) => {
  await orders.updateItems(req.valid.params.id, req.user, req.valid.body.items);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/clarifications/:clarId/answer', validate({ params: v.clarParams, body: v.answerBody }), async (req, res) => {
  await orders.answerClarification(req.valid.params.id, req.valid.params.clarId, req.user, req.valid.body);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/submit', validate({ params: idParams }), async (req, res) => {
  await orders.submitOrder(req.valid.params.id, req.user);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/cancel', validate({ params: idParams, body: v.optionalReasonBody }), async (req, res) => {
  await orders.cancelOrder(req.valid.params.id, req.user, req.valid.body.reason);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/approve', staff, validate({ params: idParams, body: v.noteBody }), async (req, res) => {
  const { warnings } = await orders.approveOrder(req.valid.params.id, req.user, req.valid.body.note);
  await detail(req, res, req.valid.params.id, { warnings });
});

router.post('/:id/reject', staff, validate({ params: idParams, body: v.reasonBody }), async (req, res) => {
  await orders.rejectOrder(req.valid.params.id, req.user, req.valid.body.reason);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/start-picking', staff, validate({ params: idParams }), async (req, res) => {
  await fulfilment.startPicking(req.valid.params.id, req.user);
  await detail(req, res, req.valid.params.id);
});

router.patch('/:id/items/:itemId/pick', staff, validate({ params: v.itemParams, body: v.pickBody }), async (req, res) => {
  await fulfilment.pickItem(req.valid.params.id, req.valid.params.itemId, req.user, req.valid.body);
  await detail(req, res, req.valid.params.id);
});

router.post('/:id/finish-packing', staff, validate({ params: idParams, body: v.finishPackingBody }), async (req, res) => {
  const { duplicate } = await fulfilment.finishPacking(req.valid.params.id, req.user, req.valid.body);
  await detail(req, res, req.valid.params.id, { duplicate });
});

router.post('/:id/collect', staff, validate({ params: idParams, body: v.collectBody }), async (req, res) => {
  const { duplicate } = await fulfilment.collectOrder(req.valid.params.id, req.user, req.valid.body);
  await detail(req, res, req.valid.params.id, { duplicate });
});

export default router;
