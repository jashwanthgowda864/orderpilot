import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api.js';
import OrderInput from '../components/OrderInput.jsx';
import { ErrorBox, Money, useLoad } from '../components/ui.jsx';

/** Staff take an order for a customer at the counter (text, photo or voice). */
export default function Counter() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [customer, setCustomer] = useState(null);
  const { data, error } = useLoad(() => get(`/customers?limit=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => r.customers), [q]);
  return (
    <div className="stack">
      <h2>Counter order</h2>
      {!customer ? (
        <section className="card">
          <h3>Who is this order for?</h3>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" />
          <ErrorBox error={error} />
          <ul className="choose">
            {data?.filter((c) => c.active).map((c) => (
              <li key={c.id}><button className="secondary" onClick={() => setCustomer(c)}>{c.name} <span className="muted small">{c.phone} · owes <Money value={c.balance} /></span></button></li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <p>For <strong>{customer.name}</strong> ({customer.phone}) <button className="link" onClick={() => setCustomer(null)}>change</button></p>
          <OrderInput customerId={customer.id} onCreated={(o) => nav(`/orders/${o.id}`)} />
        </>
      )}
    </div>
  );
}
