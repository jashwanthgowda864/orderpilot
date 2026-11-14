import { useCallback, useEffect, useState } from 'react';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const Money = ({ value }) => <span className="num">{inr.format(Number(value || 0))}</span>;
export const money = (v) => inr.format(Number(v || 0));
export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtQty = (q) => (q == null ? '—' : Number(q).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

export const STATUS_LABEL = {
  needs_clarification: 'Needs answers', draft: 'Draft', submitted: 'Waiting for approval', approved: 'Approved',
  picking: 'Being packed', ready: 'Ready for pickup', collected: 'Collected', rejected: 'Rejected', cancelled: 'Cancelled',
};
export const StatusBadge = ({ status }) => <span className={`badge st-${status}`}>{STATUS_LABEL[status] || status}</span>;

export function Confidence({ level }) {
  if (level === 'low') return <span className="conf conf-low" title="Low AI confidence — please check">check</span>;
  if (level === 'medium') return <span className="conf conf-medium" title="Medium AI confidence">medium</span>;
  return null;
}

/** Feature 2: exact phrase/line from the customer's input that produced this line. */
export function SourceTrail({ item }) {
  if (!item?.source_text) return null;
  return <div className="muted small">from: “{item.source_text}”</div>;
}

/** Feature 5: ready-time estimate text. */
export function ReadyEstimate({ order }) {
  if (!order) return null;
  if (order.status === 'ready') return <span>Ready now</span>;
  if (!['approved', 'picking'].includes(order.status) || order.ready_estimate_minutes == null) return null;
  const mins = Number(order.ready_estimate_minutes);
  if (mins > 120) return <span>Ready in more than 2 hours</span>;
  const by = order.ready_estimate_at
    ? new Date(order.ready_estimate_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : null;
  return <span>Ready in about {mins} minutes{by ? ` (by ${by})` : ''}</span>;
}

export const ErrorBox = ({ error }) => (error ? <div className="error" role="alert">{error.message || String(error)}</div> : null);

/** Runs an async loader; returns { data, error, loading, reload, setData }. */
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return loader().then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => setState((s) => ({ ...s, error, loading: false })));
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Wraps an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

/** Feature 1 & 3: marks a line from the previous order or a substitution. */
export function OriginTag({ item, basedOn }) {
  if (item?.origin === 'previous_order') {
    return <span className="tag tag-prev" title="Copied from your previous order">from last order{basedOn ? ` #${basedOn.order_no}` : ''}</span>;
  }
  if (item?.origin === 'substitution') {
    return <span className="tag tag-sub" title="Substitute item">substitute</span>;
  }
  return null;
}
