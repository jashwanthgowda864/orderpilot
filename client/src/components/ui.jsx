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
  if (!level) return null;
  return <span className={`conf conf-${level}`} title={`AI confidence: ${level}`}>{level}</span>;
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

/** Feature 1: marks a line that came from the customer's previous order. */
export function OriginTag({ item, basedOn }) {
  if (item?.origin !== 'previous_order') return null;
  return <span className="tag tag-prev" title="Copied from your previous order">from last order{basedOn ? ` #${basedOn.order_no}` : ''}</span>;
}
