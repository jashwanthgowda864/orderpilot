import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, newKey, post } from '../api.js';
import OrderInput from '../components/OrderInput.jsx';
import { ErrorBox, Money, fmtQty, useAction, useLoad } from '../components/ui.jsx';
import OrdersTable from './OrdersTable.jsx';

function ReorderNudges({ suggestions, onReload, onCreated }) {
  const [selected, setSelected] = useState({});
  const [qtys, setQtys] = useState({});
  const keyRef = useRef(newKey());
  const act = useAction();

  useEffect(() => {
    if (!suggestions) return;
    const sel = {};
    const q = {};
    for (const s of suggestions) {
      sel[s.product_id] = s.in_stock;
      q[s.product_id] = String(s.suggested_quantity);
    }
    setSelected(sel);
    setQtys(q);
    keyRef.current = newKey();
  }, [suggestions]);

  if (!suggestions?.length) return null;

  const picked = suggestions.filter((s) => selected[s.product_id] && Number(qtys[s.product_id]) > 0);
  const createDraft = () => act.run(async () => {
    const items = picked.map((s) => ({ sku: s.sku, quantity: Number(qtys[s.product_id]) }));
    const res = await post('/reorder/draft', { items, idempotency_key: keyRef.current });
    if (res?.order) onCreated(res.order);
  });
  const dismiss = (productId) => act.run(async () => {
    await post('/reorder/dismiss', { product_id: productId });
    onReload();
  });

  return (
    <section className="card">
      <div className="row spread">
        <h3>Time to restock?</h3>
        <span className="muted small">Based on your usual orders</span>
      </div>
      <table className="items">
        <tbody>
          {suggestions.map((s) => (
            <tr key={s.product_id}>
              <td>
                <div className="row">
                  <input
                    id={`nudge-${s.product_id}`}
                    type="checkbox"
                    checked={Boolean(selected[s.product_id])}
                    disabled={!s.in_stock}
                    onChange={(e) => setSelected({ ...selected, [s.product_id]: e.target.checked })}
                  />
                  <label htmlFor={`nudge-${s.product_id}`} className="grow">
                    <span>
                      <strong>{s.name}</strong>
                      {!s.in_stock && <span className="tag conf-low">Out of stock</span>}
                    </span>
                    <span className="small muted">
                      Usually every {fmtQty(s.median_gap_days)} days · last ordered {fmtQty(s.days_since_last)} days ago · <Money value={s.price} />
                    </span>
                  </label>
                </div>
              </td>
              <td>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="qty"
                  disabled={!s.in_stock}
                  value={qtys[s.product_id] ?? ''}
                  onChange={(e) => setQtys({ ...qtys, [s.product_id]: e.target.value })}
                  aria-label={`Quantity for ${s.name}`}
                />
              </td>
              <td className="r">
                <button type="button" className="link small" disabled={act.busy} onClick={() => dismiss(s.product_id)}>Dismiss</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorBox error={act.error} />
      <div className="row">
        <button type="button" disabled={act.busy || !picked.length} onClick={createDraft}>
          {act.busy ? 'Creating…' : `Review draft (${picked.length} item${picked.length === 1 ? '' : 's'})`}
        </button>
      </div>
    </section>
  );
}

const TERMINAL = ['collected', 'rejected', 'cancelled'];

export default function CustomerHome() {
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => get('/orders?limit=20').then((r) => r.orders), []);
  const { data: suggestions, reload: reloadSuggestions } = useLoad(() => get('/reorder/suggestions').then((r) => r.suggestions), []);

  useEffect(() => {
    if (!data?.some((o) => !TERMINAL.includes(o.status))) return undefined;
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [data, reload]);

  const needingSubs = (data || []).filter((o) => o.pending_substitutions > 0);
  return (
    <div className="stack">
      {needingSubs.map((o) => (
        <div key={o.id} className="card attention">
          <strong>Substitute options waiting on Order #{o.order_no}</strong>
          <p className="small">An item was short or unavailable while packing. <Link to={`/orders/${o.id}`}>Choose a substitute →</Link></p>
        </div>
      ))}
      <h2>New order</h2>
      <OrderInput onCreated={(o) => nav(`/orders/${o.id}`)} />
      <ReorderNudges suggestions={suggestions} onReload={reloadSuggestions} onCreated={(o) => nav(`/orders/${o.id}`)} />
      <h2>Your orders</h2>
      <ErrorBox error={error} />
      <OrdersTable orders={data} />
    </div>
  );
}
