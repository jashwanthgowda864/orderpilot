import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../api.js';
import { Confidence, ErrorBox, Money, OriginTag, StatusBadge, fmtQty, useAction, useLoad } from '../components/ui.jsx';

export default function PickOrder() {
  const { id } = useParams();
  const { data: order, error, setData } = useLoad(() => get(`/orders/${id}`).then((r) => r.order), [id]);
  const act = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!order) return <p className="muted">Loading…</p>;

  const mark = (item, pick_status, packed_qty) => act.run(async () =>
    setData((await patch(`/orders/${order.id}/items/${item.id}/pick`, { pick_status, ...(packed_qty != null ? { packed_qty } : {}) })).order));
  const short = (item) => {
    const v = window.prompt(`How many of ${item.name} were packed? (ordered ${fmtQty(item.quantity)})`);
    if (v != null && v.trim() !== '') mark(item, 'short', Number(v));
  };
  const pending = order.items.filter((i) => i.pick_status === 'pending').length;
  const finish = () => {
    if (pending && !window.confirm(`${pending} item(s) not marked. Mark them as fully packed and finish?`)) return;
    act.run(async () => setData((await post(`/orders/${order.id}/finish-packing`, { pack_remaining: pending > 0 })).order));
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
        {order.items.map((i) => (
          <li key={i.id} className={`pick-row pick-${i.pick_status} ${i.confidence === 'low' ? 'low' : ''}`}>
            <div className="grow">
              <strong>{fmtQty(i.quantity)} × {i.name}</strong> <Confidence level={i.confidence} /> <OriginTag item={i} basedOn={order.based_on} />
              <div className="small muted">{i.sku} · {i.category} · stock {fmtQty(i.stock_qty)}</div>
              {i.pick_status !== 'pending' && <div className="small">Packed: {fmtQty(i.packed_qty)} ({i.pick_status})</div>}
            </div>
            {order.status === 'picking' && (
              <div className="row">
                <button disabled={act.busy} className={i.pick_status === 'packed' ? '' : 'secondary'} onClick={() => mark(i, 'packed')}>Packed</button>
                <button disabled={act.busy} className="secondary" onClick={() => short(i)}>Short</button>
                <button disabled={act.busy} className="secondary" onClick={() => mark(i, 'unavailable')}>Unavailable</button>
                {i.pick_status !== 'pending' && <button disabled={act.busy} className="link" onClick={() => mark(i, 'pending')}>Undo</button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={act.error} />
      {order.status === 'picking' && <button disabled={act.busy} onClick={finish}>Finish packing</button>}
      {order.invoice && (
        <div className="card">Packed. Invoice #{order.invoice.invoice_no}: <strong><Money value={order.invoice.total} /></strong> · <Link to={`/orders/${order.id}`}>Hand over</Link></div>
      )}
    </div>
  );
}
