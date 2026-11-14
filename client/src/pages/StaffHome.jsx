import { useState } from 'react';
import { get } from '../api.js';
import { ErrorBox, STATUS_LABEL, useLoad } from '../components/ui.jsx';
import OrdersTable from './OrdersTable.jsx';

const FILTERS = [
  ['submitted', 'To approve'], ['approved,picking', 'Picking'], ['ready', 'Ready for pickup'],
  ['needs_clarification,draft', 'Drafts'], ['collected', 'Collected'], ['', 'All'],
];

export default function StaffHome() {
  const [filter, setFilter] = useState('submitted');
  const { data, error, loading } = useLoad(() => get(`/orders?limit=100${filter ? `&status=${filter}` : ''}`).then((r) => r.orders), [filter]);
  return (
    <div className="stack">
      <h2>Orders</h2>
      <div className="tabs">
        {FILTERS.map(([f, label]) => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{label}</button>)}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <p className="muted">Loading…</p> : (
        <OrdersTable orders={data} showCustomer empty={`No ${filter ? filter.split(',').map((s) => STATUS_LABEL[s].toLowerCase()).join(' / ') : ''} orders.`} />
      )}
    </div>
  );
}
