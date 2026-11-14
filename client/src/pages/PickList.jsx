import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { ErrorBox, StatusBadge, fmtDate, useLoad } from '../components/ui.jsx';

export default function PickList() {
  const { data, error, reload } = useLoad(() => get('/orders/pick-queue').then((r) => r.queue), []);
  return (
    <div className="stack">
      <div className="page-head"><h2>Pick list</h2><button className="secondary" onClick={reload}>Refresh</button></div>
      <ErrorBox error={error} />
      {!data?.length ? <p className="muted">Nothing to pick. Approved orders appear here.</p> : (
        <table className="list">
          <thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Progress</th><th>Approved</th></tr></thead>
          <tbody>{data.map((o) => (
            <tr key={o.id}>
              <td><Link to={o.status === 'picking' ? `/pick/${o.id}` : `/orders/${o.id}`}>#{o.order_no}</Link></td>
              <td>{o.customer_name}</td><td><StatusBadge status={o.status} /></td>
              <td>{o.picked_count}/{o.item_count}</td><td className="small">{fmtDate(o.approved_at)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
