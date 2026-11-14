import { useNavigate } from 'react-router-dom';
import { get } from '../api.js';
import OrderInput from '../components/OrderInput.jsx';
import { ErrorBox, useLoad } from '../components/ui.jsx';
import OrdersTable from './OrdersTable.jsx';

export default function CustomerHome() {
  const nav = useNavigate();
  const { data, error } = useLoad(() => get('/orders?limit=20').then((r) => r.orders), []);
  return (
    <div className="stack">
      <h2>New order</h2>
      <OrderInput onCreated={(o) => nav(`/orders/${o.id}`)} />
      <h2>Your orders</h2>
      <ErrorBox error={error} />
      <OrdersTable orders={data} />
    </div>
  );
}
