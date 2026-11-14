import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, newKey } from '../api.js';
import { ErrorBox, Money, fmtDate, useAction, useLoad } from '../components/ui.jsx';
import OrdersTable from './OrdersTable.jsx';

export default function CustomerDetail() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => get(`/customers/${id}`), [id]);
  const { data: orders } = useLoad(() => get(`/orders?customer_id=${id}&limit=20`).then((r) => r.orders), [id]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [key, setKey] = useState(newKey());
  const act = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { customer: c, ledger } = data;
  const pay = (e) => {
    e.preventDefault();
    act.run(async () => { await post('/payments', { customer_id: c.id, amount: Number(amount), method, idempotency_key: key }); setAmount(''); setKey(newKey()); reload(); });
  };
  return (
    <div className="stack">
      <h2>{c.name}</h2>
      <p className="muted">{c.phone} · language: {c.preferred_language || 'not set'} · credit limit <Money value={c.credit_limit} /></p>
      <section className="card">
        <p>Balance: <strong className={c.balance > 0 ? 'warn' : ''}><Money value={c.balance} /></strong></p>
        <form className="row" onSubmit={pay}>
          <input type="number" min="0.01" step="0.01" className="qty" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" aria-label="Payment amount" />
          <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="other">Other</option></select>
          <button disabled={act.busy || !(Number(amount) > 0)}>Record payment</button>
        </form>
        <ErrorBox error={act.error} />
      </section>
      <section className="card"><h3>Recent orders</h3><OrdersTable orders={orders} /></section>
      <section className="card">
        <h3>Ledger</h3>
        <table className="list"><tbody>{ledger.map((l) => (
          <tr key={l.id}><td>{l.entry_type}</td><td className="r"><Money value={l.amount} /></td><td className="r">→ <Money value={l.balance_after} /></td><td className="small">{fmtDate(l.created_at)}</td></tr>
        ))}</tbody></table>
      </section>
      <Link to="/customers">← All customers</Link>
    </div>
  );
}
