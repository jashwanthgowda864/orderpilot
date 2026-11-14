import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { get, patch, post } from '../api.js';
import { Confidence, ErrorBox, Money, OriginTag, SourceTrail, StatusBadge, fmtQty, useAction, useLoad } from '../components/ui.jsx';

export default function PickOrder() {
  const { id } = useParams();
  const { shop } = useAuth();
  const { data: order, error, setData } = useLoad(() => get(`/orders/${id}`).then((r) => r.order), [id]);
  const act = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!order) return <p className="muted">Loading…</p>;

  const waitLimit = shop?.substitution_wait_minutes ?? 10;
  const subsByItem = new Map();
  for (const s of order.substitutions || []) {
    const list = subsByItem.get(s.original_item_id) || [];
    list.push(s);
    subsByItem.set(s.original_item_id, list);
  }
  const pendingSubs = (order.substitutions || []).filter((s) => s.status === 'pending');
  const waitMinutesOf = (s) => Math.max(0, Math.floor((Date.now() - new Date(s.created_at).getTime()) / 60000));
  const maxWait = pendingSubs.reduce((m, s) => Math.max(m, waitMinutesOf(s)), 0);

  const mark = (item, pick_status, packed_qty) => act.run(async () =>
    setData((await patch(`/orders/${order.id}/items/${item.id}/pick`, { pick_status, ...(packed_qty != null ? { packed_qty } : {}) })).order));
  const respondSub = (subId, action) => act.run(async () =>
    setData((await post(`/orders/${order.id}/substitutions/${subId}/${action}`)).order));
  const short = (item) => {
    const v = window.prompt(`How many of ${item.name} were packed? (ordered ${fmtQty(item.quantity)})`);
    if (v != null && v.trim() !== '') mark(item, 'short', Number(v));
  };
  const pending = order.items.filter((i) => i.pick_status === 'pending').length;
  const finish = (proceedWithout = false) => {
    if (pending && !window.confirm(`${pending} item(s) not marked. Mark them as fully packed and finish?`)) return;
    if (pendingSubs.length > 0 && !proceedWithout) {
      if (!window.confirm(`${pendingSubs.length} substitute offer(s) still waiting for customer reply. Finish packing anyway?`)) return;
      proceedWithout = true;
    }
    act.run(async () => setData((await post(`/orders/${order.id}/finish-packing`, {
      pack_remaining: pending > 0,
      proceed_without_substitutes: proceedWithout,
    })).order));
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Pick #{order.order_no} <StatusBadge status={order.status} /></h2>
        <Link to={`/orders/${order.id}`}>Order details</Link>
      </div>
      <p>{order.customer.name}</p>
      {order.status === 'approved' && (
        <button onClick={() => act.run(async () => setData((await post(`/orders/${order.id}/start-picking`)).order))}>Start picking</button>
      )}
      <ul className="picklist">
        {order.items.map((i) => {
          const itemSubs = subsByItem.get(i.id) || [];
          const hasAccepted = itemSubs.some((s) => s.status === 'accepted');
          return (
            <li key={i.id} className={`pick-row pick-${i.pick_status} ${i.confidence === 'low' ? 'low' : ''}`}>
              <div className="grow">
                <strong>{fmtQty(i.quantity)} × {i.name}</strong> <Confidence level={i.confidence} /> <OriginTag item={i} basedOn={order.based_on} />
                <div className="small muted">{i.sku} · {i.category} · stock {fmtQty(i.stock_qty)}</div>
                {i.substitutes_name && <div className="small muted">replaces {i.substitutes_name}</div>}
                <SourceTrail item={i} />
                {i.pick_status !== 'pending' && <div className="small">Packed: {fmtQty(i.packed_qty)} ({i.pick_status})</div>}
                {itemSubs.length > 0 && (
                  <div className="sub-box">
                    <div className="small"><strong>Substitute options:</strong></div>
                    {itemSubs.map((s) => (
                      <div key={s.id} className="row wrap small">
                        <span className="grow">
                          {fmtQty(s.quantity)} × {s.product_name} ({s.product_sku}) · <Money value={s.product_price} /> · <strong>{s.status}</strong>
                          {s.status === 'pending' && ` (${waitMinutesOf(s)}m waiting)`}
                        </span>
                        {order.status === 'picking' && s.status === 'pending' && (
                          <>
                            <button disabled={act.busy} onClick={() => respondSub(s.id, 'accept')}>Accept</button>
                            <button disabled={act.busy} className="secondary" onClick={() => respondSub(s.id, 'decline')}>Decline</button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {itemSubs.length === 0 && (i.pick_status === 'short' || i.pick_status === 'unavailable') && (
                  <div className="small muted">No alternative available</div>
                )}
              </div>
              {order.status === 'picking' && (
                <div className="row">
                  <button disabled={act.busy || hasAccepted} title={hasAccepted ? 'Substitute accepted' : ''} className={i.pick_status === 'packed' ? '' : 'secondary'} onClick={() => mark(i, 'packed')}>Packed</button>
                  <button disabled={act.busy} className="secondary" onClick={() => short(i)}>Short</button>
                  <button disabled={act.busy} className="secondary" onClick={() => mark(i, 'unavailable')}>Unavailable</button>
                  {i.pick_status !== 'pending' && <button disabled={act.busy || hasAccepted} className="link" onClick={() => mark(i, 'pending')}>Undo</button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorBox error={act.error} />
      {order.status === 'picking' && pendingSubs.length > 0 && (
        <div className={maxWait >= waitLimit ? 'card attention' : 'banner'}>
          <div>{pendingSubs.length} substitute offer(s) awaiting customer reply ({maxWait}m elapsed; wait threshold {waitLimit}m).</div>
          <div className="row">
            <button disabled={act.busy} className={maxWait >= waitLimit ? '' : 'secondary'} onClick={() => finish(true)}>Proceed without substitutes</button>
          </div>
        </div>
      )}
      {order.status === 'picking' && pendingSubs.length === 0 && (
        <button disabled={act.busy} onClick={() => finish(false)}>Finish packing</button>
      )}
      {order.invoice && (
        <div className="card">Packed. Invoice #{order.invoice.invoice_no}: <strong><Money value={order.invoice.total} /></strong> · <Link to={`/orders/${order.id}`}>Hand over</Link></div>
      )}
    </div>
  );
}
