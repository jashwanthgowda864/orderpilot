import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, get, post } from '../api.js';
import ProductPicker from '../components/ProductPicker.jsx';
import { ErrorBox, Money, fmtDate, fmtQty, useAction, useLoad } from '../components/ui.jsx';

const UNIT_BASE = {
  kg: ['mass', 1], g: ['mass', 0.001],
  l: ['vol', 1], ml: ['vol', 0.001],
  pcs: ['count', 1], pack: ['pack', 1],
};

function convertBillQtyToPacks(quantity, unit, product) {
  if (!(Number(quantity) > 0) || !product) return '';
  if (!unit || unit === 'pack') return String(quantity);
  const from = UNIT_BASE[unit];
  const to = UNIT_BASE[product.unit];
  if (!from || !to || from[0] !== to[0]) return String(quantity);
  const packs = (Number(quantity) * from[1]) / (Number(product.pack_size) * to[1]);
  return String(Math.round(packs * 1000) / 1000);
}

function scanLoadingText(s) {
  if (s < 6) return 'Reading your supplier bill…';
  if (s < 12) return 'Matching lines to products…';
  if (s < 24) return 'The AI is slower than usual. Still working…';
  return 'Almost there. Trying a faster backup…';
}

function BillReview({ bill, products, onUpdated, onReloadList }) {
  const [supplierName, setSupplierName] = useState(bill.supplier_name || '');
  const [billNumber, setBillNumber] = useState(bill.bill_number || '');
  const [billDate, setBillDate] = useState(bill.bill_date ? String(bill.bill_date).slice(0, 10) : '');
  const [rows, setRows] = useState([]);
  const [fileUrl, setFileUrl] = useState(null);
  const act = useAction();

  useEffect(() => {
    setSupplierName(bill.supplier_name || '');
    setBillNumber(bill.bill_number || '');
    setBillDate(bill.bill_date ? String(bill.bill_date).slice(0, 10) : '');
    setFileUrl(null);
    setRows((bill.matched_lines || []).map((l, idx) => ({
      idx,
      raw: l,
      product_id: l.matched_product_id || null,
      product_name: l.matched_name || '',
      product_sku: l.matched_sku || '',
      packs: l.suggested_packs != null ? String(l.suggested_packs) : '',
      unit_cost: l.suggested_unit_cost != null ? String(l.suggested_unit_cost) : '',
      skip: false,
    })));
  }, [bill]);

  useEffect(() => () => {
    if (fileUrl?.startsWith('blob:')) URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  const showPhoto = () => act.run(async () => {
    const r = await api('GET', `/supplier-bills/${bill.id}/file`);
    setFileUrl(r instanceof Blob ? URL.createObjectURL(r) : r.url);
  });

  const pickProduct = (idx, prod) => {
    setRows((rs) => rs.map((r) => {
      if (r.idx !== idx) return r;
      const packs = convertBillQtyToPacks(r.raw.quantity, r.raw.unit, prod);
      const unitCost = r.raw.line_total != null && Number(packs) > 0
        ? String(Math.round((Number(r.raw.line_total) / Number(packs)) * 100) / 100)
        : r.unit_cost;
      return { ...r, product_id: prod.id, product_name: prod.name, product_sku: prod.sku, packs, unit_cost: unitCost, skip: false };
    }));
  };

  const activeRows = rows.filter((r) => !r.skip);
  const readyToApply = bill.status === 'draft'
    && activeRows.length > 0
    && activeRows.every((r) => r.product_id && Number(r.packs) > 0);

  const apply = async (confirmDupDate = false) => {
    const payload = {
      supplier_name: supplierName.trim() || null,
      bill_number: billNumber.trim() || null,
      bill_date: billDate || null,
      ...(confirmDupDate ? { confirm_duplicate_date: true } : {}),
      lines: rows.map((r) => ({
        product_id: r.product_id || null,
        packs: r.packs ? Number(r.packs) : null,
        unit_cost: r.unit_cost !== '' ? Number(r.unit_cost) : null,
        skip: r.skip,
      })),
    };
    try {
      const res = await api('POST', `/supplier-bills/${bill.id}/apply`, payload);
      if (res?.bill) { onUpdated(res.bill); onReloadList(); }
    } catch (e) {
      if (e.code === 'confirm_duplicate_date' && window.confirm(`${e.message}`)) {
        return apply(true);
      }
      act.setError(e);
    }
  };

  const discard = () => {
    if (!window.confirm('Discard this scanned bill without changing stock?')) return;
    act.run(async () => {
      const res = await post(`/supplier-bills/${bill.id}/discard`, {});
      if (res?.bill) { onUpdated(res.bill); onReloadList(); }
    });
  };

  return (
    <section className="card">
      <div className="page-head">
        <h3>Bill review <span className={`badge st-${bill.status}`}>{bill.status}</span></h3>
        {bill.has_file && !fileUrl && <button type="button" className="link" onClick={showPhoto}>Show bill photo</button>}
      </div>
      {fileUrl && <img className="preview" src={fileUrl} alt="Supplier bill" />}

      {bill.warnings?.map((w, i) => <div key={i} className="banner">{w}</div>)}

      {bill.status === 'draft' ? (
        <>
          <div className="row wrap">
            <label>Supplier<input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} placeholder="Supplier name" /></label>
            <label>Bill #<input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} placeholder="Bill number" /></label>
            <label>Bill date<input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></label>
          </div>
          <table className="items">
            <thead>
              <tr><th>Bill line</th><th>Matched product</th><th>Packs to add</th><th>Unit cost (₹)</th><th>Skip</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.idx} className={!r.skip && !r.product_id ? 'low' : r.skip ? 'muted' : ''}>
                  <td>
                    <strong>{r.raw.name}</strong>
                    <div className="small muted">
                      {r.raw.quantity != null ? `${fmtQty(r.raw.quantity)} ${r.raw.unit || ''}` : 'qty unclear'}
                      {r.raw.line_total != null ? ` · ₹${fmtQty(r.raw.line_total)}` : ''}
                    </div>
                  </td>
                  <td>
                    {r.product_id ? (
                      <div className="row wrap">
                        <span><strong>{r.product_name}</strong> <span className="small muted">({r.product_sku})</span></span>
                        <button type="button" className="link small" onClick={() => setRows((rs) => rs.map((x) => x.idx === r.idx ? { ...x, product_id: null, product_name: '', product_sku: '' } : x))}>Change</button>
                      </div>
                    ) : (
                      <div className="stack">
                        {r.raw.candidates?.length > 0 && (
                          <div className="options">
                            {r.raw.candidates.map((c) => {
                              const full = products.find((p) => p.id === c.id);
                              return full ? (
                                <button key={c.id} type="button" className="secondary small" onClick={() => pickProduct(r.idx, full)}>{c.name}</button>
                              ) : null;
                            })}
                          </div>
                        )}
                        <ProductPicker products={products} onPick={(p) => pickProduct(r.idx, p)} placeholder="Match product…" />
                      </div>
                    )}
                  </td>
                  <td>
                    <input className="qty" type="number" min="0" step="any" disabled={r.skip}
                      value={r.packs} onChange={(e) => setRows((rs) => rs.map((x) => x.idx === r.idx ? { ...x, packs: e.target.value } : x))}
                      aria-label={`Packs for ${r.raw.name}`} />
                  </td>
                  <td>
                    <input className="qty" type="number" min="0" step="0.01" disabled={r.skip}
                      value={r.unit_cost} onChange={(e) => setRows((rs) => rs.map((x) => x.idx === r.idx ? { ...x, unit_cost: e.target.value } : x))}
                      aria-label={`Unit cost for ${r.raw.name}`} />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.skip}
                      onChange={(e) => setRows((rs) => rs.map((x) => x.idx === r.idx ? { ...x, skip: e.target.checked } : x))}
                      aria-label={`Skip ${r.raw.name}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ErrorBox error={act.error} />
          <div className="actions">
            <button type="button" disabled={act.busy || !readyToApply} onClick={() => act.run(() => apply(false))}>
              {act.busy ? 'Applying…' : 'Apply to stock'}
            </button>
            <button type="button" className="secondary" disabled={act.busy} onClick={discard}>Discard</button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            {bill.supplier_name || 'Unknown supplier'}{bill.bill_number ? ` · #${bill.bill_number}` : ''}{bill.bill_date ? ` · ${String(bill.bill_date).slice(0, 10)}` : ''}
          </p>
          {bill.applied_lines?.length > 0 && (
            <table className="items">
              <thead><tr><th>Product</th><th>Packs added</th><th className="r">Unit cost</th></tr></thead>
              <tbody>
                {bill.applied_lines.map((l, i) => (
                  <tr key={i}><td>{l.name} <span className="small muted">{l.sku}</span></td><td>{fmtQty(l.packs)}</td><td className="r">{l.unit_cost != null ? <Money value={l.unit_cost} /> : '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

export default function SupplierBills() {
  const [photo, setPhoto] = useState(null);
  const [waited, setWaited] = useState(0);
  const [activeBill, setActiveBill] = useState(null);
  const scanAct = useAction();
  const { data: bills, reload: reloadBills } = useLoad(() => get('/supplier-bills').then((r) => r.bills), []);
  const { data: products } = useLoad(() => get('/products').then((r) => r.products), []);

  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => photoUrl && URL.revokeObjectURL(photoUrl), [photoUrl]);

  useEffect(() => {
    if (!scanAct.busy) { setWaited(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [scanAct.busy]);

  const uploadBill = (e) => {
    e.preventDefault();
    if (!photo || scanAct.busy) return;
    scanAct.run(async () => {
      const fd = new FormData();
      fd.set('file', photo, photo.name || 'bill.jpg');
      const res = await api('POST', '/supplier-bills/scan', fd);
      if (res?.bill) {
        setPhoto(null);
        setActiveBill(res.bill);
        reloadBills();
      }
    });
  };

  const openBill = async (id) => {
    const res = await get(`/supplier-bills/${id}`);
    setActiveBill(res.bill);
  };

  const aiBusy = scanAct.error?.code === 'ai_busy';
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Stock in from supplier bill</h2>
        <Link to="/products">← Products & stock</Link>
      </div>

      <form className="card" onSubmit={uploadBill} aria-busy={scanAct.busy}>
        <h3>Scan a new bill</h3>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment"
          disabled={scanAct.busy} onChange={(e) => setPhoto(e.target.files?.[0] || null)} aria-label="Supplier bill photo" />
        {photoUrl && <img className="preview" src={photoUrl} alt="Selected supplier bill" />}
        {scanAct.busy && (
          <div className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{scanLoadingText(waited)}</span>
            <span className="muted small">{waited}s</span>
          </div>
        )}
        {!scanAct.busy && scanAct.error && (
          <div className={aiBusy ? 'banner' : 'error'} role="alert">
            <strong>{scanAct.error.message}</strong>
            {aiBusy && <div className="small">Your bill photo is still selected. Press “Try again”.</div>}
          </div>
        )}
        <button type="submit" disabled={scanAct.busy || !photo}>
          {scanAct.busy ? 'Scanning…' : aiBusy ? 'Try again' : 'Scan bill'}
        </button>
      </form>

      {activeBill && products && (
        <BillReview bill={activeBill} products={products} onUpdated={setActiveBill} onReloadList={reloadBills} />
      )}

      <section className="card">
        <h3>Recent bills</h3>
        {!bills?.length ? <p className="muted">No scanned bills yet.</p> : (
          <table className="list">
            <thead><tr><th>Supplier</th><th>Bill #</th><th>Date</th><th>Status</th><th>Total</th><th>Scanned</th></tr></thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td><button type="button" className="link" onClick={() => openBill(b.id)}>{b.supplier_name || 'Unknown supplier'}</button></td>
                  <td>{b.bill_number || '—'}</td>
                  <td className="small">{b.bill_date ? String(b.bill_date).slice(0, 10) : '—'}</td>
                  <td><span className={`badge st-${b.status}`}>{b.status}</span></td>
                  <td>{b.total != null ? <Money value={b.total} /> : '—'}</td>
                  <td className="small">{fmtDate(b.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
