import { useEffect, useState } from 'react';
import { put } from '../api.js';
import ProductPicker from './ProductPicker.jsx';
import { Confidence, ErrorBox, Money, OriginTag, SourceTrail, useAction } from './ui.jsx';

/** Editable item list for draft orders. */
export default function ReviewItems({ order, products, onUpdated }) {
  const [rows, setRows] = useState([]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    setRows(order.items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, quantity: i.quantity, unit_price: i.unit_price, confidence: i.confidence, origin: i.origin, source_text: i.source_text })));
  }, [order]);

  const dirty = JSON.stringify(rows.map((r) => [r.id, r.sku, Number(r.quantity)])) !==
    JSON.stringify(order.items.map((i) => [i.id, i.sku, Number(i.quantity)]));
  const setQty = (idx, v) => setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, quantity: v } : r)));
  const remove = (idx) => setRows((rs) => rs.filter((_, i) => i !== idx));
  const add = (p) => setRows((rs) => {
    const existing = rs.findIndex((r) => r.sku === p.sku);
    if (existing >= 0) return rs.map((r, i) => (i === existing ? { ...r, quantity: Number(r.quantity) + 1 } : r));
    return [...rs, { sku: p.sku, name: p.name, quantity: 1, unit_price: p.price, confidence: null }];
  });
  const save = () => run(async () => {
    const items = rows.filter((r) => Number(r.quantity) > 0).map((r) => ({ ...(r.id ? { id: r.id } : {}), sku: r.sku, quantity: Number(r.quantity) }));
    onUpdated((await put(`/orders/${order.id}/items`, { items })).order);
  });

  const total = rows.reduce((s, r) => s + Number(r.quantity || 0) * Number(r.unit_price || 0), 0);
  return (
    <section className="card">
      <h3>Check your items</h3>
      <table className="items">
        <thead><tr><th>Item</th><th>Qty</th><th className="r">Amount</th><th /></tr></thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id || r.sku} className={r.confidence === 'low' ? 'low' : ''}>
              <td>{r.name} <Confidence level={r.confidence} /> <OriginTag item={r} basedOn={order.based_on} /><div className="muted small">{r.sku}</div><SourceTrail item={r} /></td>
              <td><input className="qty" type="number" min="0" step="any" value={r.quantity} onChange={(e) => setQty(idx, e.target.value)} aria-label={`Quantity of ${r.name}`} /></td>
              <td className="r"><Money value={Number(r.quantity || 0) * Number(r.unit_price || 0)} /></td>
              <td><button className="link" onClick={() => remove(idx)} aria-label={`Remove ${r.name}`}>✕</button></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="muted">No items yet. Add some below.</td></tr>}
        </tbody>
        <tfoot><tr><td colSpan={2}>Estimated total</td><td className="r"><Money value={total} /></td><td /></tr></tfoot>
      </table>
      <ProductPicker products={products} onPick={add} placeholder="Add a product…" />
      <ErrorBox error={error} />
      {dirty && <button onClick={save} disabled={busy || !rows.some((r) => Number(r.quantity) > 0)}>{busy ? 'Saving…' : 'Save changes'}</button>}
    </section>
  );
}
