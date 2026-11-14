import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Money, fmtDate, useAction, useLoad } from '../components/ui.jsx';

function NewCustomer({ onCreated }) {
  const [f, setF] = useState({ name: '', phone: '', preferred_language: '', password: '' });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { name: f.name.trim(), phone: f.phone.trim(), preferred_language: f.preferred_language || null };
      if (f.password) body.password = f.password;
      await post('/customers', body);
      setF({ name: '', phone: '', preferred_language: '', password: '' });
      onCreated();
    });
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>Add customer</h3>
      <div className="row wrap">
        <input placeholder="Name" value={f.name} onChange={set('name')} required />
        <input placeholder="Phone" inputMode="tel" value={f.phone} onChange={set('phone')} required />
        <select value={f.preferred_language} onChange={set('preferred_language')} aria-label="Preferred language">
          <option value="">Language: not set</option><option value="en">English</option><option value="kn">Kannada</option><option value="hi">Hindi</option>
        </select>
        <input type="password" placeholder="App password (optional, 8+)" value={f.password} onChange={set('password')} minLength={8} />
        <button disabled={busy}>Add</button>
      </div>
      <ErrorBox error={error} />
    </form>
  );
}

export default function Customers() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad(() => get(`/customers?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => r.customers), [q]);
  return (
    <div className="stack">
      <h2>Customers</h2>
      {user.role === 'owner' && <NewCustomer onCreated={reload} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" />
      <ErrorBox error={error} />
      <table className="list">
        <thead><tr><th>Name</th><th>Phone</th><th className="r">Balance</th><th>Last payment</th></tr></thead>
        <tbody>{data?.map((c) => (
          <tr key={c.id}><td><Link to={`/customers/${c.id}`}>{c.name}</Link>{!c.active && <span className="muted small"> (disabled)</span>}</td>
            <td>{c.phone}</td><td className={`r ${c.balance > 0 ? 'warn' : ''}`}><Money value={c.balance} /></td><td className="small">{fmtDate(c.last_payment_at)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}
