import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { ErrorBox, Money, STATUS_LABEL, fmtDate, fmtQty, useLoad } from '../components/ui.jsx';

export default function Dashboard() {
  const { data, error } = useLoad(() => get('/dashboard'), []);
  const { data: events } = useLoad(() => get('/ai-events?limit=10').then((r) => r.events), []);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const s = data.orders_by_status;
  return (
    <div className="stack">
      <h2>Dashboard</h2>
      <div className="tiles">
        <div className="tile"><span className="muted small">Sales today</span><strong><Money value={data.sales_today.total} /></strong><span className="small">{data.sales_today.count} invoices</span></div>
        <div className="tile"><span className="muted small">Last 7 days</span><strong><Money value={data.sales_7d.total} /></strong><span className="small">{data.sales_7d.count} invoices</span></div>
        <div className="tile"><span className="muted small">Outstanding</span><strong><Money value={data.outstanding.total} /></strong><span className="small">{data.outstanding.customers} customers</span></div>
        <div className="tile"><span className="muted small">Waiting</span><strong>{(s.submitted || 0)} to approve</strong><span className="small">{(s.approved || 0) + (s.picking || 0)} picking · {s.ready || 0} ready</span></div>
      </div>
      <section className="card">
        <h3>Orders by status</h3>
        <p className="small">{Object.entries(s).map(([k, v]) => `${STATUS_LABEL[k] || k}: ${v}`).join(' · ') || 'No orders yet.'}</p>
      </section>
      <section className="card">
        <h3>Low stock</h3>
        {!data.low_stock.length ? <p className="muted">Nothing below reorder level.</p> : (
          <table className="list"><tbody>{data.low_stock.map((p) => (
            <tr key={p.id}><td>{p.name} <span className="small muted">{p.sku}</span></td><td className="warn">{fmtQty(p.stock_qty)}</td><td className="small muted">reorder at {fmtQty(p.reorder_level)}</td></tr>
          ))}</tbody></table>
        )}
        <Link to="/products">Manage stock →</Link>
      </section>
      <section className="card">
        <h3>Recent AI activity</h3>
        {!events?.length ? <p className="muted">No AI calls yet.</p> : (
          <table className="list"><tbody>{events.map((e) => (
            <tr key={e.id}><td>{e.kind}{e.mock && <span className="small muted"> (mock)</span>}</td><td className={e.status === 'error' ? 'warn' : ''}>{e.status}</td>
              <td className="small muted">{e.error || e.input_summary}</td><td className="small">{fmtDate(e.created_at)}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </div>
  );
}
