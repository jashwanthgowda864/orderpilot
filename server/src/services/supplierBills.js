import { createHash, randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { HttpError, badRequest, conflict, notFound } from '../middleware/error.js';
import { IMAGE_EXT } from '../middleware/upload.js';
import { allowsFraction, rankProducts, toSellableUnits } from './catalogMatch.js';
import { parseSupplierBill } from './gemini.js';
import { loadCatalog } from './orders.js';
import { applyMovement } from './stock.js';
import { removeFile, uploadFile } from './storage.js';

const round2 = (n) => Math.round(n * 100) / 100;

function matchLine(line, catalog, bySku) {
  const exact = line.sku ? bySku.get(line.sku.toLowerCase()) : null;
  const ranked = exact ? [] : rankProducts(line.name, catalog, 3);
  const unambiguous = !exact && ranked[0] && ranked[0].score >= 0.6
    && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.15);
  const product = exact || (unambiguous ? ranked[0].p : null);

  let suggestedPacks = null;
  if (product && line.quantity != null) {
    suggestedPacks = line.unit ? toSellableUnits(line.quantity, line.unit, product) : Number(line.quantity);
  }
  let suggestedUnitCost = null;
  if (line.line_total != null && suggestedPacks && suggestedPacks > 0) {
    suggestedUnitCost = round2(Number(line.line_total) / suggestedPacks);
  } else if (line.unit_price != null) {
    suggestedUnitCost = round2(Number(line.unit_price));
  }

  return {
    ...line,
    matched_product_id: product?.id || null,
    matched_sku: product?.sku || null,
    matched_name: product?.name || null,
    candidates: ranked.map((r) => ({ id: r.p.id, sku: r.p.sku, name: r.p.name })),
    suggested_packs: suggestedPacks,
    suggested_unit_cost: suggestedUnitCost,
  };
}

function buildWarnings(bill, alreadyAppliedFile) {
  const warnings = [];
  if (alreadyAppliedFile) {
    warnings.push('This exact bill photo has already been applied to stock.');
  }
  const lines = bill.extracted?.lines || [];
  const lineTotals = lines.map((l) => l.line_total).filter((v) => v != null);
  if (bill.total != null && lineTotals.length === lines.length && lineTotals.length > 0) {
    const sum = round2(lineTotals.reduce((a, b) => a + Number(b), 0));
    if (Math.abs(sum - Number(bill.total)) > 1) {
      warnings.push(`Line amounts add up to ₹${sum.toLocaleString('en-IN')}, while the bill total says ₹${Number(bill.total).toLocaleString('en-IN')}.`);
    }
  }
  return warnings;
}

export async function formatBillDetail(bill, db = pool) {
  const catalog = await loadCatalog(db);
  const bySku = new Map(catalog.map((p) => [p.sku.toLowerCase(), p]));
  const matchedLines = (bill.extracted?.lines || []).map((l) => matchLine(l, catalog, bySku));
  const dupFile = bill.status === 'draft'
    ? (await db.query(
      `select 1 from supplier_bills where file_sha256 = $1 and status = 'applied' and id <> $2 limit 1`,
      [bill.file_sha256, bill.id],
    )).rows.length > 0
    : false;
  const { file_path, ...pub } = bill;
  return {
    ...pub,
    has_file: Boolean(file_path),
    matched_lines: matchedLines,
    warnings: buildWarnings(bill, dupFile),
  };
}

export async function listSupplierBills({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `select id, supplier_name, bill_number, bill_date, status, total, created_at, applied_at
     from supplier_bills order by created_at desc limit $1 offset $2`,
    [limit, offset],
  );
  return rows;
}

export async function getSupplierBillRow(id, db = pool, { lock = false } = {}) {
  const { rows } = await db.query(
    `select * from supplier_bills where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('Supplier bill not found.');
  return rows[0];
}

export async function scanSupplierBill({ file, user }) {
  if (!file) throw badRequest('Upload a photo of the supplier bill.');
  const sha = createHash('sha256').update(file.buffer).digest('hex');
  const catalog = await loadCatalog();
  const extracted = await parseSupplierBill({ file, catalog, userId: user.id });

  const d = new Date();
  const ext = IMAGE_EXT[file.mimetype] || 'jpg';
  const filePath = `supplier-bills/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
  await uploadFile(filePath, file.buffer, file.mimetype);

  try {
    const { rows } = await pool.query(
      `insert into supplier_bills (supplier_name, bill_number, bill_date, file_path, file_sha256, status, extracted, total, created_by)
       values ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
       returning *`,
      [
        extracted.supplier_name,
        extracted.bill_number,
        extracted.bill_date,
        filePath,
        sha,
        JSON.stringify(extracted),
        extracted.total,
        user.id,
      ],
    );
    return await formatBillDetail(rows[0]);
  } catch (err) {
    await removeFile(filePath);
    throw err;
  }
}

export async function applySupplierBill(id, user, body) {
  const activeLines = body.lines.filter((l) => !l.skip);
  if (!activeLines.length) throw badRequest('Keep at least one line to add stock, or discard the bill.');
  for (const l of activeLines) {
    if (!l.product_id) throw badRequest('Match or skip every line before applying.');
    if (!(Number(l.packs) > 0)) throw badRequest('Enter a positive pack quantity for each kept line.');
  }

  const supplierName = body.supplier_name?.trim() || null;
  const billNumber = body.bill_number?.trim() || null;
  const billDate = body.bill_date || null;

  const updated = await withTransaction(async (client) => {
    const bill = await getSupplierBillRow(id, client, { lock: true });
    if (bill.status !== 'draft') throw conflict(`This bill is already ${bill.status}.`);

    const dupFile = await client.query(
      `select id from supplier_bills where file_sha256 = $1 and status = 'applied' and id <> $2 limit 1`,
      [bill.file_sha256, bill.id],
    );
    if (dupFile.rows[0]) throw conflict('This exact bill photo was already applied to stock.');

    if (supplierName && billNumber && billDate) {
      const dupNum = await client.query(
        `select id from supplier_bills
         where status = 'applied'
           and lower(btrim(supplier_name)) = lower(btrim($1))
           and lower(btrim(bill_number)) = lower(btrim($2))
           and bill_date = $3
           and id <> $4
         limit 1`,
        [supplierName, billNumber, billDate, bill.id],
      );
      if (dupNum.rows[0]) {
        throw conflict(`Bill #${billNumber} from ${supplierName} on ${billDate} was already applied.`);
      }
    } else if (!billNumber && supplierName && billDate && !body.confirm_duplicate_date) {
      const sameDate = await client.query(
        `select id from supplier_bills
         where status = 'applied'
           and lower(btrim(supplier_name)) = lower(btrim($1))
           and bill_date = $2
           and id <> $3
         limit 1`,
        [supplierName, billDate, bill.id],
      );
      if (sameDate.rows[0]) {
        throw new HttpError(
          409,
          `A bill from ${supplierName} on ${billDate} was already applied. Confirm to apply anyway.`,
          undefined,
          'confirm_duplicate_date',
        );
      }
    }

    const productIds = [...new Set(activeLines.map((l) => l.product_id))];
    const { rows: prodRows } = await client.query(
      `select id, sku, name, unit, pack_size from products where id = any($1)`,
      [productIds],
    );
    const prodById = new Map(prodRows.map((p) => [p.id, p]));

    // Merge duplicate product_ids so one stock movement is recorded per product per bill.
    const merged = new Map();
    for (const l of activeLines) {
      const p = prodById.get(l.product_id);
      if (!p) throw badRequest('One of the selected products does not exist.');
      const packs = Number(l.packs);
      if (!allowsFraction(p) && !Number.isInteger(packs)) {
        throw badRequest(`${p.name} must be stocked in whole packs.`);
      }
      const prev = merged.get(p.id) || { product: p, packs: 0, costSum: 0, costPacks: 0 };
      prev.packs = Math.round((prev.packs + packs) * 1000) / 1000;
      if (l.unit_cost != null) {
        prev.costSum += packs * Number(l.unit_cost);
        prev.costPacks += packs;
      }
      merged.set(p.id, prev);
    }

    const noteParts = [supplierName, billNumber ? `#${billNumber}` : null].filter(Boolean);
    const note = noteParts.length ? `Supplier bill (${noteParts.join(' ')})` : 'Supplier bill';

    const appliedSummary = [];
    for (const entry of merged.values()) {
      const unitCost = entry.costPacks > 0 ? round2(entry.costSum / entry.costPacks) : null;
      await applyMovement(client, {
        productId: entry.product.id,
        type: 'inward',
        quantity: entry.packs,
        unitCost,
        refType: 'supplier_bill',
        refId: bill.id,
        note,
        userId: user.id,
      });
      appliedSummary.push({
        product_id: entry.product.id,
        sku: entry.product.sku,
        name: entry.product.name,
        packs: entry.packs,
        unit_cost: unitCost,
      });
    }

    const { rows: saved } = await client.query(
      `update supplier_bills
       set status = 'applied', supplier_name = $2, bill_number = $3, bill_date = $4,
           applied_lines = $5, applied_by = $6, applied_at = now()
       where id = $1
       returning *`,
      [bill.id, supplierName, billNumber, billDate, JSON.stringify(appliedSummary), user.id],
    );
    return saved[0];
  });

  return formatBillDetail(updated);
}

export async function discardSupplierBill(id) {
  const updated = await withTransaction(async (client) => {
    const bill = await getSupplierBillRow(id, client, { lock: true });
    if (bill.status === 'discarded') return bill;
    if (bill.status !== 'draft') throw conflict(`This bill is already ${bill.status}.`);
    const { rows } = await client.query(
      `update supplier_bills set status = 'discarded' where id = $1 returning *`,
      [id],
    );
    return rows[0];
  });
  return formatBillDetail(updated);
}
