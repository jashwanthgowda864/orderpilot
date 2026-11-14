import { Link } from 'react-router-dom';
import { Money, StatusBadge, fmtDate } from '../components/ui.jsx';

export default function OrdersTable({ orders, showCustomer, empty = 'No orders yet.' }) {
  if (!orders?.length) return <p className="muted">{empty}</p>;
  return (
    <table className="list">
      <thead><tr><th>#</th>{showCustomer && <th>Customer</th>}<th>Status</th><th>Items</th><th className="r">Value</th><th>Placed</th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td><Link to={`/orders/${o.id}`}>#{o.order_no}</Link></td>
            {showCustomer && <td>{o.customer_name}</td>}
            <td><StatusBadge status={o.status} />{o.open_questions > 0 && <span className="small muted"> · {o.open_questions} question(s)</span>}</td>
            <td>{o.item_count}</td>
            <td className="r"><Money value={o.invoice_total ?? o.subtotal} /></td>
            <td className="small">{fmtDate(o.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
