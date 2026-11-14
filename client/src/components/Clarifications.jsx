import { useState } from 'react';
import { post } from '../api.js';
import ProductPicker from './ProductPicker.jsx';
import { ErrorBox, money, useAction } from './ui.jsx';

function Question({ order, q, products, onUpdated }) {
  const [qty, setQty] = useState('');
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const answer = (body) => run(async () => onUpdated((await post(`/orders/${order.id}/clarifications/${q.id}/answer`, body)).order));
  const item = order.items.find((i) => i.id === q.item_id);

  return (
    <div className="question">
      <p><strong>{q.question}</strong></p>
      {item && <p className="muted small">You wrote: “{item.name}”</p>}
      {q.kind === 'choose_product' && (
        <div className="stack">
          <div className="options">
            {q.options.map((o) => (
              <button key={o.sku} disabled={busy} className="secondary" onClick={() => answer({ sku: o.sku })}>
                {o.name} <span className="small muted">{money(o.price)}</span>
              </button>
            ))}
          </div>
          <ProductPicker products={products} onPick={(p) => answer({ sku: p.sku })} placeholder="Or search for another product…" />
        </div>
      )}
      {q.kind === 'quantity' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (Number(qty) > 0) answer({ quantity: Number(qty) }); }}>
          {q.options.map((o) => (
            <button type="button" key={o.quantity} className="secondary" disabled={busy} onClick={() => answer({ quantity: o.quantity })}>{o.quantity}</button>
          ))}
          <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" className="qty" />
          <button type="submit" disabled={busy || !(Number(qty) > 0)}>OK</button>
        </form>
      )}
      {q.kind === 'free_text' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) answer({ text: text.trim() }); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" maxLength={500} />
          <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Send'}</button>
        </form>
      )}
      <button className="link small" disabled={busy} onClick={() => answer({ skip: true })}>
        {q.item_id ? 'Remove this item' : 'Skip'}
      </button>
      {busy && q.kind === 'free_text' && (
        <div className="loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span>Reading your answer…</span></div>
      )}
      <ErrorBox error={error} />
      {error?.code === 'ai_busy' && <p className="small muted">Your answer is still in the box. Press Send to try again.</p>}
    </div>
  );
}

export default function Clarifications({ order, products, onUpdated }) {
  const open = order.clarifications.filter((q) => !q.answered_at);
  if (!open.length) return null;
  return (
    <section className="card attention">
      <h3>A few questions before we continue</h3>
      {open.map((q) => <Question key={q.id} order={order} q={q} products={products} onUpdated={onUpdated} />)}
    </section>
  );
}
