import { useState } from 'react';
import { get, patch, post } from '../api.js';
import { ErrorBox, Money, fmtQty, useAction, useLoad } from '../components/ui.jsx';

function StockRow({ p, onChanged }) {
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState(String(p.price));
  const act = useAction();
  const inward = () => act.run(async () => { await post('/stock/movements', { product_id: p.id, type: 'inward', quantity: Number(qty), note: 'Manual inward' }); setQty(''); onChanged(); });
  const savePrice = () => act.run(async () => { await patch(`/products/${p.id}`, { price: Number(price) }); onChanged(); });
  const toggle = () => act.run(async () => { await patch(`/products/${p.id}`, { active: !p.active }); onChanged(); });
  return (
    <tr className={p.active ? '' : 'muted'}>
      <td>{p.name}<div className="small muted">{p.sku} · {p.category}</div>{act.error && <div className="error small">{act.error.message}</div>}</td>
      <td className={Number(p.stock_qty) <= Number(p.reorder_level) ? 'warn' : ''}>{fmtQty(p.stock_qty)}</td>
      <td><div className="row"><input className="qty" type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`Price of ${p.name}`} />
        {Number(price) !== Number(p.price) && <button className="secondary" disabled={act.busy} onClick={savePrice}>Save</button>}</div></td>
      <td><div className="row"><input className="qty" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="+ qty" aria-label={`Add stock for ${p.name}`} />
        <button className="secondary" disabled={act.busy || !(Number(qty) > 0)} onClick={inward}>Add</button></div></td>
      <td><button className="link" onClick={toggle}>{p.active ? 'Disable' : 'Enable'}</button></td>
    </tr>
  );
}

function NewProduct({ onCreated }) {
  const empty = { sku: '', name: '', category: '', unit: 'pcs', pack_size: '1', price: '', opening_stock: '0' };
  const [f, setF] = useState(empty);
  const act = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    act.run(async () => {
      await post('/products', { sku: f.sku.trim(), name: f.name.trim(), category: f.category.trim(), unit: f.unit,
        pack_size: Number(f.pack_size), price: Number(f.price), opening_stock: Number(f.opening_stock || 0) });
      setF(empty); onCreated();
    });
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>Add product</h3>
      <div className="row wrap">
        <input placeholder="SKU" value={f.sku} onChange={set('sku')} required />
        <input placeholder="Name" value={f.name} onChange={set('name')} required />
        <input placeholder="Category" value={f.category} onChange={set('category')} required />
        <select value={f.unit} onChange={set('unit')} aria-label="Unit">{['kg', 'g', 'l', 'ml', 'pcs', 'pack'].map((u) => <option key={u}>{u}</option>)}</select>
        <input className="qty" type="number" step="any" min="0" placeholder="Pack size" value={f.pack_size} onChange={set('pack_size')} required />
        <input className="qty" type="number" step="0.01" min="0" placeholder="Price" value={f.price} onChange={set('price')} required />
        <input className="qty" type="number" step="any" min="0" placeholder="Opening stock" value={f.opening_stock} onChange={set('opening_stock')} />
        <button disabled={act.busy}>Add</button>
      </div>
      <ErrorBox error={act.error} />
    </form>
  );
}

export default function Products() {
  const { data, error, reload } = useLoad(() => get('/products').then((r) => r.products), []);
  return (
    <div className="stack">
      <h2>Products & stock</h2>
      <NewProduct onCreated={reload} />
      <ErrorBox error={error} />
      <table className="list">
        <thead><tr><th>Product</th><th>Stock</th><th>Price</th><th>Stock in</th><th /></tr></thead>
        <tbody>{data?.map((p) => <StockRow key={p.id} p={p} onChanged={reload} />)}</tbody>
      </table>
      <p className="small muted">Prices are per pack. Total catalogue value at price: <Money value={(data || []).reduce((s, p) => s + p.price * p.stock_qty, 0)} /></p>
    </div>
  );
}
