import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { ErrorBox, Money, fmtDate, useLoad } from '../components/ui.jsx';

export default function Account() {
  const { data, error } = useLoad(() => get('/customers/me'), []);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { customer, payments, invoices } = data;
  return (
    <div className="stack">
      <h2>{customer.name}</h2>
      <section className="card">
        <p>{customer.balance > 0 ? 'You owe' : customer.balance < 0 ? 'Credit with shop' : 'Balance'}: <strong><Money value={Math.abs(customer.balance)} /></strong></p>
      </section>
      <section className="card">
        <h3>Invoices</h3>
        {!invoices.length ? <p className="muted">No invoices yet.</p> : (
          <table className="list"><tbody>{invoices.map((i) => (
            <tr key={i.id}><td><Link to={`/invoices/${i.id}`}>Invoice #{i.invoice_no}</Link></td><td>Order #{i.order_no}</td><td className="r"><Money value={i.total} /></td><td className="small">{fmtDate(i.created_at)}</td></tr>
          ))}</tbody></table>
        )}
      </section>
      <section className="card">
        <h3>Payments</h3>
        {!payments.length ? <p className="muted">No payments yet.</p> : (
          <table className="list"><tbody>{payments.map((p) => (
            <tr key={p.id}><td>{p.method.toUpperCase()}</td><td className="r"><Money value={p.amount} /></td><td className="small">{fmtDate(p.created_at)}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </div>
  );
}
