import { Link, useParams } from 'react-router-dom';
import { get } from '../api.js';
import { ErrorBox, Money, fmtDate, fmtQty, useLoad } from '../components/ui.jsx';

export default function InvoicePage() {
  const { id } = useParams();
  const { data, error } = useLoad(() => get(`/invoices/${id}`), [id]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { invoice: inv, shop } = data;
  return (
    <div className="card invoice">
      <div className="row spread">
        <div><h2>{shop?.name}</h2><p className="small muted">{shop?.address}{shop?.phone ? ` · ${shop.phone}` : ''}</p></div>
        <div className="r"><h3>Invoice #{inv.invoice_no}</h3><p className="small">{fmtDate(inv.created_at)}</p></div>
      </div>
      <p>Bill to: <strong>{inv.customer_name}</strong> ({inv.customer_phone}) · <Link to={`/orders/${inv.order_id}`}>Order #{inv.order_no}</Link></p>
      <table className="items">
        <thead><tr><th>Item</th><th>Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
        <tbody>{inv.lines.map((l) => (
          <tr key={l.item_id}><td>{l.name}<div className="small muted">{l.sku}{l.ordered_quantity !== l.quantity ? ` · ordered ${fmtQty(l.ordered_quantity)}` : ''}{l.substitutes_sku ? ` · substitute for ${l.substitutes_sku}` : ''}</div></td>
            <td>{fmtQty(l.quantity)}</td><td className="r"><Money value={l.unit_price} /></td><td className="r"><Money value={l.line_total} /></td></tr>
        ))}</tbody>
        <tfoot>
          <tr><td colSpan={3}>Subtotal</td><td className="r"><Money value={inv.subtotal} /></td></tr>
          {Number(inv.tax) > 0 && <tr><td colSpan={3}>Tax</td><td className="r"><Money value={inv.tax} /></td></tr>}
          <tr className="total"><td colSpan={3}>Total</td><td className="r"><Money value={inv.total} /></td></tr>
        </tfoot>
      </table>
      <button className="secondary noprint" onClick={() => window.print()}>Print</button>
    </div>
  );
}
