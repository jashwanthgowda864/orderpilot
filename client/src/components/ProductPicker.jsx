import { useMemo, useState } from 'react';
import { money } from './ui.jsx';

/** Searchable product chooser. onPick(product). */
export default function ProductPicker({ products, onPick, placeholder = 'Search products…', exclude = [] }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return products.filter((p) => !exclude.includes(p.sku) && [p.name, p.sku, p.name_kn, p.name_hi, ...(p.aliases || [])]
      .some((t) => t && t.toLowerCase().includes(s))).slice(0, 8);
  }, [q, products, exclude]);
  return (
    <div className="picker">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {results.length > 0 && (
        <ul className="picker-list">
          {results.map((p) => (
            <li key={p.sku}>
              <button type="button" onClick={() => { onPick(p); setQ(''); }}>
                {p.name} <span className="muted small">{p.sku} · {money(p.price)}{p.in_stock === false ? ' · out of stock' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
