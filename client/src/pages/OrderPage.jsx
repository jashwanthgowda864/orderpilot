import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, newKey, api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Clarifications from '../components/Clarifications.jsx';
import ReviewItems from '../components/ReviewItems.jsx';
import { Confidence, ErrorBox, Money, OriginTag, ReadyEstimate, SourceTrail, StatusBadge, fmtDate, fmtQty, money, useAction, useLoad } from '../components/ui.jsx';

const TERMINAL = ['collected', 'rejected', 'cancelled'];

function SubstitutionOffers({ order, onUpdated }) {
  const act = useAction();
  const pending = (order.substitutions || []).filter((s) => s.status === 'pending');
  if (order.status !== 'picking' || pending.length === 0) return null;

  const grouped = new Map();
  for (const s of pending) {
    const list = grouped.get(s.original_item_id) || [];
    list.push(s);
    grouped.set(s.original_item_id, list);
  }
  const respond = (subId, action) => act.run(async () =>
    onUpdated((await post(`/orders/${order.id}/substitutions/${subId}/${action}`)).order));

  return (
    <section className="card attention stack">
      <h3>Substitute needed</h3>
      <p className="small">An item on your order is short or unavailable. Choose whether to accept an alternative:</p>
      {[...grouped.entries()].map(([origId, list]) => {
        const orig = order.items.find((i) => i.id === origId);
        return (
          <div key={origId} className="stack">
            {orig && (
              <div className="small">
                <strong>Requested:</strong> {fmtQty(orig.quantity)} × {orig.name}
                {orig.packed_qty != null ? ` (${fmtQty(orig.packed_qty)} packed)` : ''}
              </div>
            )}
            {list.map((s) => (
              <div key={s.id} className="sub-card row wrap spread">
                <div>
                  <div><strong>{fmtQty(s.quantity)} × {s.product_name}</strong> <span className="small muted">({s.product_sku})</span></div>
                  <div className="small muted"><Money value={s.product_price} /> each · total <Money value={Number(s.quantity) * Number(s.product_price)} />{s.reason ? ` · ${s.reason}` : ''}</div>
                </div>
                <div className="row">
                  <button disabled={act.busy} onClick={() => respond(s.id, 'accept')}>Accept</button>
                  <button disabled={act.busy} className="secondary" onClick={() => respond(s.id, 'decline')}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <ErrorBox error={act.error} />
    </section>
  );
}

function ReadOnlyItems({ order, showStock }) {
  const hasPacked = order.items.some((i) => i.packed_qty != null);
  const cols = 2 + (hasPacked ? 1 : 0) + (showStock ? 1 : 0);
  return (
    <section className="card">
      <h3>Items</h3>
      <table className="items">
        <thead><tr><th>Item</th><th>Ordered</th>{hasPacked && <th>Packed</th>}{showStock && <th>In stock</th>}<th className="r">Amount</th></tr></thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id} className={i.confidence === 'low' ? 'low' : ''}>
              <td>
                {i.name} <Confidence level={i.confidence} /> <OriginTag item={i} basedOn={order.based_on} />
                <div className="muted small">{i.sku || 'not matched'}{i.substitutes_name ? ` · replaces ${i.substitutes_name}` : ''}</div>
                <SourceTrail item={i} />
              </td>
              <td>{fmtQty(i.quantity)}</td>
              {hasPacked && <td>{i.packed_qty == null ? '—' : fmtQty(i.packed_qty)} {i.pick_status !== 'pending' && <span className={`pick pick-${i.pick_status}`}>{i.pick_status}</span>}</td>}
              {showStock && <td className={Number(i.stock_qty) < Number(i.quantity) ? 'warn' : ''}>{fmtQty(i.stock_qty)}</td>}
              <td className="r"><Money value={Number(i.quantity) * Number(i.unit_price || 0)} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={cols}>Order value</td><td className="r"><Money value={order.subtotal} /></td></tr></tfoot>
      </table>
    </section>
  );
}

function CollectPanel({ order, onDone }) {
  const [amount, setAmount] = useState(String(order.invoice?.total ?? ''));
  const [method, setMethod] = useState('cash');
  const [key] = useState(newKey());
  const { busy, error, run } = useAction();
  const collect = (withPayment) => run(async () => {
    const body = withPayment && Number(amount) > 0 ? { payment: { amount: Number(amount), method, idempotency_key: key } } : {};
    onDone((await post(`/orders/${order.id}/collect`, body)).order);
  });
  return (
    <section className="card">
      <h3>Hand over to customer</h3>
      <p className="muted small">Current balance: <Money value={order.customer?.balance} /> (includes this invoice)</p>
      <div className="row">
        <input type="number" min="0" step="0.01" className="qty" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Payment amount" />
        <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method">
          <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="other">Other</option>
        </select>
        <button disabled={busy || !(Number(amount) > 0)} onClick={() => collect(true)}>Collected + paid</button>
        <button className="secondary" disabled={busy} onClick={() => collect(false)}>Collected on credit</button>
      </div>
      <ErrorBox error={error} />
    </section>
  );
}

export default function OrderPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const isStaff = user.role !== 'customer';
  const { data: order, error, setData, reload } = useLoad(() => get(`/orders/${id}`).then((r) => r.order), [id]);
  const { data: products } = useLoad(() => get('/products').then((r) => r.products.filter((p) => p.active !== false)), []);
  const act = useAction();
  const [warnings, setWarnings] = useState([]);
  const [fileUrl, setFileUrl] = useState(null);
  const [qtyWarnings, setQtyWarnings] = useState(null); // quantity anomaly check before submit

  // Keep status fresh while the order is moving.
  useEffect(() => {
    if (!order || TERMINAL.includes(order.status)) return undefined;
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [order, reload]);

  if (error) return <ErrorBox error={error} />;
  if (!order) return <p className="muted">Loading…</p>;
  const can = (s) => order.allowed_actions.includes(s);
  const doPost = (path, body) => act.run(async () => {
    const r = await post(`/orders/${order.id}/${path}`, body);
    setData(r.order); if (r.warnings) setWarnings(r.warnings);
    return r.order;
  });

  const showFile = () => act.run(async () => {
    const r = await api('GET', `/orders/${order.id}/file`);
    setFileUrl(r instanceof Blob ? URL.createObjectURL(r) : r.url);
  });

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Order #{order.order_no} <StatusBadge status={order.status} /></h2>
          <p className="muted small">
            {isStaff && <><Link to={`/customers/${order.customer.id}`}>{order.customer.name}</Link> · </>}
            {order.channel} · {fmtDate(order.created_at)}
          </p>
          {(order.status === 'ready' || (['approved', 'picking'].includes(order.status) && order.ready_estimate_minutes != null)) && (
            <p className="small"><strong><ReadyEstimate order={order} /></strong></p>
          )}
        </div>
      </div>

      {order.based_on && (
        <p className="based-on">Based on {isStaff ? 'order' : 'your order'} <Link to={`/orders/${order.based_on.id}`}>#{order.based_on.order_no}</Link> from {fmtDate(order.based_on.created_at)}. Items marked <span className="tag tag-prev">from last order</span> were copied from it.</p>
      )}
      {order.status === 'rejected' && <div className="error">Rejected: {order.rejected_reason}</div>}
      {warnings.length > 0 && <div className="banner">Low stock: {warnings.join('; ')}</div>}
      <SubstitutionOffers order={order} onUpdated={setData} />

      {(order.raw_text || order.transcript || order.has_file) && (
        <section className="card source">
          <h3>What was sent</h3>
          {order.raw_text && <p className="pre">{order.raw_text}</p>}
          {order.transcript && <p className="pre muted">Heard/read: {order.transcript}</p>}
          {order.has_file && !fileUrl && <button className="link" onClick={showFile}>Show attached {order.channel === 'voice' ? 'voice note' : 'photo'}</button>}
          {fileUrl && (order.channel === 'voice' ? <audio controls src={fileUrl} /> : <img className="preview" src={fileUrl} alt="Order attachment" />)}
        </section>
      )}

      {order.status === 'needs_clarification' && products && <Clarifications order={order} products={products} onUpdated={setData} />}
      {order.status === 'draft' && products ? <ReviewItems order={order} products={products} onUpdated={setData} /> : <ReadOnlyItems order={order} showStock={isStaff && ['submitted', 'approved', 'picking'].includes(order.status)} />}

      {order.notes && <section className="card"><h3>Notes</h3><p className="pre">{order.notes}</p></section>}

      {order.invoice && (
        <section className="card row spread">
          <span>Invoice #{order.invoice.invoice_no}: <strong><Money value={order.invoice.total} /></strong>{Number(order.invoice.total) !== Number(order.subtotal) && <span className="muted small"> (charged for what was packed)</span>}</span>
          <Link to={`/invoices/${order.invoice.id}`}>View invoice</Link>
        </section>
      )}

      {can('collected') && <CollectPanel order={order} onDone={setData} />}

      {qtyWarnings?.length > 0 && order.status === 'draft' && (
        <section className="card attention" role="alert">
          <h3>Please check these quantities</h3>
          <ul className="plain-list">{qtyWarnings.map((w) => <li key={w.item_id}>{w.message}</li>)}</ul>
          <div className="actions">
            <button disabled={act.busy} onClick={async () => { if (await doPost('submit')) setQtyWarnings(null); }}>Confirm and submit</button>
            <button className="secondary" disabled={act.busy} onClick={() => setQtyWarnings(null)}>Change</button>
          </div>
        </section>
      )}

      <div className="actions">
        {can('submitted') && order.status === 'draft' && !qtyWarnings?.length && (
          <button disabled={act.busy || !order.items.length} onClick={() => act.run(async () => {
            const check = await get(`/orders/${order.id}/quantity-check`);
            if (check.warnings.length) { setQtyWarnings(check.warnings); return; }
            const r = await post(`/orders/${order.id}/submit`);
            setData(r.order);
          })}>Submit order · {money(order.subtotal)}</button>
        )}
        {can('approved') && <button disabled={act.busy} onClick={() => doPost('approve', {})}>Approve</button>}
        {can('rejected') && (
          <button className="danger" disabled={act.busy} onClick={() => {
            const reason = window.prompt('Reason for rejecting (shown to the customer):');
            if (reason?.trim()) doPost('reject', { reason: reason.trim() });
          }}>Reject</button>
        )}
        {can('picking') && <button disabled={act.busy} onClick={async () => { if (await doPost('start-picking')) nav(`/pick/${order.id}`); }}>Start picking</button>}
        {isStaff && order.status === 'picking' && <Link className="button" to={`/pick/${order.id}`}>Open pick list</Link>}
        {can('cancelled') && (
          <button className="secondary" disabled={act.busy} onClick={() => window.confirm('Cancel this order?') && doPost('cancel', {})}>Cancel order</button>
        )}
      </div>
      <ErrorBox error={act.error} />

      {isStaff && order.history.length > 0 && (
        <details className="card"><summary>History</summary>
          <ul className="history">{order.history.map((h, i) => (
            <li key={i}>{fmtDate(h.created_at)} — {h.from_status ? `${h.from_status} → ` : ''}{h.to_status}{h.changed_by_name ? ` by ${h.changed_by_name}` : ''}{h.note ? ` (${h.note})` : ''}</li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}
