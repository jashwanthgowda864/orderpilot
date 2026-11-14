// Demo data: shop, owner/staff/customer logins, ~30 products, and several weeks of
// past orders with invoices, stock movements and payments (all consistent with
// the ledger). Usage:
//   npm run seed            (refuses if products already exist)
//   npm run seed -- --reset (DEV ONLY: wipes all OrderPilot data first)
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../db.js';

const RESET = process.argv.includes('--reset');
const PASSWORD = process.env.SEED_PASSWORD || 'orderpilot-demo';
const DAY = 86400000;
const now = Date.now();
const daysAgo = (d, hour = 10) => { const t = new Date(now - d * DAY); t.setHours(hour, 15, 0, 0); return t; };

const PRODUCTS = [
  // sku, name, kn, hi, aliases, category, unit, pack_size, price, reorder
  ['SUGAR-1KG', 'Sugar 1 kg', 'ಸಕ್ಕರೆ 1 ಕೆಜಿ', 'चीनी 1 किलो', ['sugar', 'sakkare', 'chini', 'cheeni'], 'Staples', 'kg', 1, 48, 20],
  ['SUGAR-5KG', 'Sugar 5 kg', 'ಸಕ್ಕರೆ 5 ಕೆಜಿ', 'चीनी 5 किलो', ['sugar bag'], 'Staples', 'kg', 5, 235, 5],
  ['RICE-SONA-5KG', 'Sona Masoori Rice 5 kg', 'ಸೋನಾ ಮಸೂರಿ ಅಕ್ಕಿ 5 ಕೆಜಿ', 'सोना मसूरी चावल 5 किलो', ['rice', 'akki', 'chawal', 'sona masoori'], 'Staples', 'kg', 5, 340, 6],
  ['RICE-SONA-10KG', 'Sona Masoori Rice 10 kg', 'ಸೋನಾ ಮಸೂರಿ ಅಕ್ಕಿ 10 ಕೆಜಿ', 'सोना मसूरी चावल 10 किलो', ['rice 10kg'], 'Staples', 'kg', 10, 660, 4],
  ['RICE-SONA-25KG', 'Sona Masoori Rice 25 kg', 'ಸೋನಾ ಮಸೂರಿ ಅಕ್ಕಿ 25 ಕೆಜಿ', 'सोना मसूरी चावल 25 किलो', ['rice bag'], 'Staples', 'kg', 25, 1600, 2],
  ['TOOR-1KG', 'Toor Dal 1 kg', 'ತೊಗರಿ ಬೇಳೆ 1 ಕೆಜಿ', 'तूर दाल 1 किलो', ['toor dal', 'tur dal', 'togari bele', 'arhar dal', 'dal'], 'Pulses', 'kg', 1, 165, 10],
  ['MOONG-500G', 'Moong Dal 500 g', 'ಹೆಸರು ಬೇಳೆ 500 ಗ್ರಾಂ', 'मूंग दाल 500 ग्राम', ['moong dal', 'hesaru bele'], 'Pulses', 'g', 500, 70, 10],
  ['URAD-500G', 'Urad Dal 500 g', 'ಉದ್ದಿನ ಬೇಳೆ 500 ಗ್ರಾಂ', 'उड़द दाल 500 ग्राम', ['urad dal', 'uddina bele'], 'Pulses', 'g', 500, 78, 10],
  ['ATTA-5KG', 'Whole Wheat Atta 5 kg', 'ಗೋಧಿ ಹಿಟ್ಟು 5 ಕೆಜಿ', 'गेहूं आटा 5 किलो', ['atta', 'wheat flour', 'godhi hittu'], 'Staples', 'kg', 5, 265, 5],
  ['RAVA-1KG', 'Bombay Rava 1 kg', 'ರವೆ 1 ಕೆಜಿ', 'सूजी 1 किलो', ['rava', 'sooji', 'suji', 'semolina'], 'Staples', 'kg', 1, 62, 8],
  ['POHA-500G', 'Poha 500 g', 'ಅವಲಕ್ಕಿ 500 ಗ್ರಾಂ', 'पोहा 500 ग्राम', ['poha', 'avalakki', 'beaten rice'], 'Staples', 'g', 500, 40, 8],
  ['SALT-1KG', 'Iodised Salt 1 kg', 'ಉಪ್ಪು 1 ಕೆಜಿ', 'नमक 1 किलो', ['salt', 'uppu', 'namak'], 'Staples', 'kg', 1, 28, 10],
  ['OIL-SUN-1L', 'Sunflower Oil 1 L', 'ಸೂರ್ಯಕಾಂತಿ ಎಣ್ಣೆ 1 ಲೀ', 'सूरजमुखी तेल 1 लीटर', ['sunflower oil', 'oil', 'enne', 'tel'], 'Oil & Ghee', 'l', 1, 155, 10],
  ['OIL-SUN-5L', 'Sunflower Oil 5 L', 'ಸೂರ್ಯಕಾಂತಿ ಎಣ್ಣೆ 5 ಲೀ', 'सूरजमुखी तेल 5 लीटर', ['oil can'], 'Oil & Ghee', 'l', 5, 740, 3],
  ['OIL-GN-1L', 'Groundnut Oil 1 L', 'ಕಡಲೆಕಾಯಿ ಎಣ್ಣೆ 1 ಲೀ', 'मूंगफली तेल 1 लीटर', ['groundnut oil', 'kadalekai enne'], 'Oil & Ghee', 'l', 1, 210, 6],
  ['GHEE-500ML', 'Ghee 500 ml', 'ತುಪ್ಪ 500 ಮಿಲೀ', 'घी 500 मिली', ['ghee', 'tuppa'], 'Oil & Ghee', 'ml', 500, 330, 4],
  ['MILK-500ML', 'Toned Milk 500 ml', 'ಹಾಲು 500 ಮಿಲೀ', 'दूध 500 मिली', ['milk', 'haalu', 'doodh'], 'Dairy', 'ml', 500, 27, 20],
  ['CURD-500G', 'Curd 500 g', 'ಮೊಸರು 500 ಗ್ರಾಂ', 'दही 500 ग्राम', ['curd', 'mosaru', 'dahi'], 'Dairy', 'g', 500, 35, 10],
  ['BUTTER-100G', 'Butter 100 g', 'ಬೆಣ್ಣೆ 100 ಗ್ರಾಂ', 'मक्खन 100 ग्राम', ['butter', 'benne'], 'Dairy', 'g', 100, 58, 10],
  ['PANEER-200G', 'Paneer 200 g', 'ಪನೀರ್ 200 ಗ್ರಾಂ', 'पनीर 200 ग्राम', ['paneer'], 'Dairy', 'g', 200, 90, 5],
  ['TEA-250G', 'Tea Powder 250 g', 'ಟೀ ಪುಡಿ 250 ಗ್ರಾಂ', 'चाय पत्ती 250 ग्राम', ['tea', 'tea powder', 'chai'], 'Beverages', 'g', 250, 140, 6],
  ['TEA-500G', 'Tea Powder 500 g', 'ಟೀ ಪುಡಿ 500 ಗ್ರಾಂ', 'चाय पत्ती 500 ग्राम', ['tea big'], 'Beverages', 'g', 500, 270, 4],
  ['COFFEE-200G', 'Filter Coffee 200 g', 'ಕಾಫಿ ಪುಡಿ 200 ಗ್ರಾಂ', 'कॉफ़ी 200 ग्राम', ['coffee', 'filter coffee', 'kaapi'], 'Beverages', 'g', 200, 160, 5],
  ['BISCUIT-GLUCO', 'Glucose Biscuits (pack)', 'ಗ್ಲೂಕೋಸ್ ಬಿಸ್ಕತ್ತು', 'ग्लूकोज़ बिस्कुट', ['biscuit', 'biscuits', 'glucose biscuit'], 'Snacks', 'pack', 1, 10, 30],
  ['BISCUIT-MARIE', 'Marie Biscuits (pack)', 'ಮೇರಿ ಬಿಸ್ಕತ್ತು', 'मैरी बिस्कुट', ['marie'], 'Snacks', 'pack', 1, 30, 15],
  ['TURMERIC-100G', 'Turmeric Powder 100 g', 'ಅರಿಶಿನ 100 ಗ್ರಾಂ', 'हल्दी 100 ग्राम', ['turmeric', 'arishina', 'haldi'], 'Spices', 'g', 100, 32, 8],
  ['CHILLI-200G', 'Chilli Powder 200 g', 'ಮೆಣಸಿನ ಪುಡಿ 200 ಗ್ರಾಂ', 'लाल मिर्च 200 ग्राम', ['chilli powder', 'menasina pudi', 'mirchi'], 'Spices', 'g', 200, 75, 6],
  ['MUSTARD-100G', 'Mustard Seeds 100 g', 'ಸಾಸಿವೆ 100 ಗ್ರಾಂ', 'राई 100 ग्राम', ['mustard', 'sasive', 'rai'], 'Spices', 'g', 100, 18, 8],
  ['JEERA-100G', 'Cumin Seeds 100 g', 'ಜೀರಿಗೆ 100 ಗ್ರಾಂ', 'जीरा 100 ग्राम', ['jeera', 'cumin', 'jeerige'], 'Spices', 'g', 100, 45, 8],
  ['DETERGENT-1KG', 'Detergent Powder 1 kg', 'ಡಿಟರ್ಜೆಂಟ್ 1 ಕೆಜಿ', 'डिटर्जेंट 1 किलो', ['detergent', 'washing powder', 'surf'], 'Household', 'kg', 1, 120, 6],
  ['DISHBAR', 'Dishwash Bar', 'ಪಾತ್ರೆ ತೊಳೆಯುವ ಸೋಪು', 'बर्तन साबुन', ['dishwash', 'vim bar'], 'Household', 'pcs', 1, 20, 10],
  ['SOAP-BATH', 'Bath Soap', 'ಸ್ನಾನದ ಸೋಪು', 'नहाने का साबुन', ['soap', 'bath soap'], 'Household', 'pcs', 1, 38, 12],
];

const SUB_GROUPS = {
  'SUGAR-1KG': 'sugar', 'SUGAR-5KG': 'sugar',
  'RICE-SONA-5KG': 'rice-sona', 'RICE-SONA-10KG': 'rice-sona', 'RICE-SONA-25KG': 'rice-sona',
  'OIL-SUN-1L': 'cooking-oil', 'OIL-SUN-5L': 'cooking-oil', 'OIL-GN-1L': 'cooking-oil',
  'TEA-250G': 'tea', 'TEA-500G': 'tea',
};

// Past orders: [customerKey, daysAgo, [[sku, qty], ...], status]
const PAST_ORDERS = [
  ['ramesh', 42, [['SUGAR-1KG', 2], ['TOOR-1KG', 1], ['OIL-SUN-1L', 2], ['TEA-250G', 1]], 'collected'],
  ['ramesh', 35, [['SUGAR-1KG', 2], ['TOOR-1KG', 1], ['RICE-SONA-5KG', 1], ['MILK-500ML', 4]], 'collected'],
  ['ramesh', 28, [['SUGAR-1KG', 2], ['TOOR-1KG', 1], ['OIL-SUN-1L', 2], ['TEA-250G', 1]], 'collected'],
  ['ramesh', 21, [['SUGAR-1KG', 2], ['TOOR-1KG', 1], ['MILK-500ML', 4], ['BISCUIT-GLUCO', 3]], 'collected'],
  ['ramesh', 14, [['SUGAR-1KG', 2], ['TOOR-1KG', 1], ['OIL-SUN-1L', 2], ['RICE-SONA-5KG', 1], ['TEA-250G', 1]], 'collected'],
  ['ramesh', 7, [['SUGAR-1KG', 3], ['TOOR-1KG', 1], ['MILK-500ML', 4]], 'collected'],
  ['fatima', 30, [['ATTA-5KG', 1], ['GHEE-500ML', 1], ['MOONG-500G', 2], ['TURMERIC-100G', 1]], 'collected'],
  ['fatima', 20, [['ATTA-5KG', 1], ['MOONG-500G', 2], ['PANEER-200G', 2]], 'collected'],
  ['fatima', 10, [['ATTA-5KG', 1], ['GHEE-500ML', 1], ['MOONG-500G', 2], ['CHILLI-200G', 1]], 'collected'],
  ['anita', 12, [['DETERGENT-1KG', 1], ['SOAP-BATH', 4], ['DISHBAR', 2], ['COFFEE-200G', 1]], 'collected'],
  ['anita', 1, [['RICE-SONA-10KG', 1], ['OIL-GN-1L', 1]], 'ready'],
];
// Payments: [customerKey, daysAgo, amount, method]
const PAYMENTS = [
  ['ramesh', 35, 1000, 'cash'], ['ramesh', 21, 1500, 'upi'], ['ramesh', 7, 500, 'cash'],
  ['fatima', 30, 900, 'upi'], ['fatima', 20, 450, 'upi'], ['fatima', 10, 812, 'upi'],
  ['anita', 12, 200, 'cash'],
];

async function main() {
  if (RESET && process.env.NODE_ENV === 'production') throw new Error('Refusing to --reset in production.');
  await withTransaction(async (c) => {
    if (RESET) {
      await c.query(`truncate ai_events, customer_ledger, payments, invoices, stock_movements, order_status_history,
        order_clarifications, substitution_suggestions, order_items, orders, supplier_bills, reorder_nudge_dismissals,
        users, products, customers, shop_settings restart identity cascade`);
    } else {
      const { rows } = await c.query('select count(*)::int as n from products');
      if (rows[0].n > 0) throw new Error('Data already exists. Use `npm run seed -- --reset` to wipe and reseed (dev only).');
    }

    await c.query(`insert into shop_settings (id, name, phone, address, tax_rate) values (1, $1, $2, $3, 0)`,
      ['Lakshmi Provision Store', '080-40000000', '12, 4th Cross, Jayanagar, Bengaluru']);

    const hash = await bcrypt.hash(PASSWORD, 10);
    const ownerId = (await c.query(`insert into users (phone, name, password_hash, role) values ('9000000001','Shop Owner',$1,'owner') returning id`, [hash])).rows[0].id;
    const staffId = (await c.query(`insert into users (phone, name, password_hash, role) values ('9000000002','Counter Staff',$1,'staff') returning id`, [hash])).rows[0].id;

    const custDefs = {
      ramesh: ['Ramesh Kumar', '9000000101', 'kn', 3000],
      fatima: ['Fatima Shaikh', '9000000102', 'hi', 2000],
      anita: ['Anita Rao', '9000000103', null, 1500],
      walkin: ['Walk-in Customer', '9000000199', null, 0],
    };
    const cust = {};
    for (const [key, [name, phone, lang, limit]] of Object.entries(custDefs)) {
      cust[key] = (await c.query(
        `insert into customers (name, phone, preferred_language, credit_limit, created_at) values ($1,$2,$3,$4,$5) returning id`,
        [name, phone, lang, limit, daysAgo(60)])).rows[0].id;
      if (key !== 'walkin') {
        await c.query(`insert into users (phone, name, password_hash, role, customer_id) values ($1,$2,$3,'customer',$4)`, [phone, name, hash, cust[key]]);
      }
    }

    // Products + opening stock (an inward movement, so stock_qty == sum(movements)).
    const prod = {};
    const sold = {};
    for (const [, , items] of PAST_ORDERS) for (const [sku, q] of items) sold[sku] = (sold[sku] || 0) + q;
    for (const [sku, name, kn, hi, aliases, category, unit, pack, price, reorder] of PRODUCTS) {
      const { rows } = await c.query(
        `insert into products (sku, name, name_kn, name_hi, aliases, category, unit, pack_size, price, reorder_level, substitute_group, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, price`,
        [sku, name, kn, hi, aliases, category, unit, pack, price, reorder, SUB_GROUPS[sku] ?? null, daysAgo(60)]);
      prod[sku] = { id: rows[0].id, price: Number(rows[0].price), name, unit };
      // A few items deliberately low for the dashboard.
      const opening = (sku === 'GHEE-500ML' ? 3 : sku === 'PANEER-200G' ? 2 : 40) + (sold[sku] || 0);
      await c.query('update products set stock_qty = $2 where id = $1', [rows[0].id, opening]);
      await c.query(`insert into stock_movements (product_id, type, quantity, unit_cost, ref_type, note, created_by, created_at)
        values ($1,'inward',$2,$3,'manual','Opening stock',$4,$5)`, [rows[0].id, opening, Math.round(price * 0.85 * 100) / 100, ownerId, daysAgo(60, 8)]);
    }

    // Ledger rows are written in chronological order so balance_after is correct.
    const events = [];
    for (const [key, d, items, status] of PAST_ORDERS) events.push({ t: daysAgo(d, 10), kind: 'order', key, items, status });
    for (const [key, d, amount, method] of PAYMENTS) events.push({ t: daysAgo(d, 18), kind: 'payment', key, amount, method });
    events.sort((a, b) => a.t - b.t);

    const balance = {};
    for (const e of events) {
      const customerId = cust[e.key];
      if (e.kind === 'payment') {
        const p = (await c.query(`insert into payments (customer_id, amount, method, received_by, created_at) values ($1,$2,$3,$4,$5) returning id`,
          [customerId, e.amount, e.method, staffId, e.t])).rows[0];
        balance[e.key] = (balance[e.key] || 0) - e.amount;
        await c.query(`insert into customer_ledger (customer_id, entry_type, amount, ref_id, balance_after, created_at) values ($1,'payment',$2,$3,$4,$5)`,
          [customerId, -e.amount, p.id, balance[e.key], e.t]);
        continue;
      }
      const t = e.t;
      const tReady = new Date(t.getTime() + 2 * 3600000);
      const tCollected = new Date(t.getTime() + 6 * 3600000);
      const userId = (await c.query('select id from users where customer_id = $1', [customerId])).rows[0].id;
      const subtotal = e.items.reduce((s, [sku, q]) => s + prod[sku].price * q, 0);
      const order = (await c.query(
        `insert into orders (customer_id, created_by, channel, status, raw_text, language, subtotal, approved_by, approved_at,
           picking_started_at, ready_at, collected_at, created_at, updated_at)
         values ($1,$2,'text',$3,$4,'en',$5,$6,$7,$7,$8,$9,$10,$8) returning id, order_no`,
        [customerId, userId, e.status, e.items.map(([sku, q]) => `${q} ${prod[sku].name}`).join(', '), subtotal, staffId,
          new Date(t.getTime() + 30 * 60000), tReady, e.status === 'collected' ? tCollected : null, t])).rows[0];
      const lines = [];
      for (const [pos, [sku, q]] of e.items.entries()) {
        const p = prod[sku];
        const item = (await c.query(
          `insert into order_items (order_id, position, product_id, sku, name, quantity, unit, unit_price, confidence, pick_status, packed_qty, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'high','packed',$6,$9) returning id`,
          [order.id, pos, p.id, sku, p.name, q, p.unit, p.price, t])).rows[0];
        await c.query('update products set stock_qty = stock_qty - $2 where id = $1', [p.id, q]);
        await c.query(`insert into stock_movements (product_id, type, quantity, ref_type, ref_id, note, created_by, created_at)
          values ($1,'sale',$2,'order_item',$3,$4,$5,$6)`, [p.id, -q, item.id, `Order #${order.order_no}`, staffId, tReady]);
        lines.push({ item_id: item.id, sku, name: p.name, quantity: q, ordered_quantity: q, unit: p.unit, unit_price: p.price, line_total: p.price * q });
      }
      const inv = (await c.query(`insert into invoices (order_id, customer_id, lines, subtotal, tax, total, created_at) values ($1,$2,$3,$4,0,$4,$5) returning id`,
        [order.id, customerId, JSON.stringify(lines), subtotal, tReady])).rows[0];
      balance[e.key] = (balance[e.key] || 0) + subtotal;
      await c.query(`insert into customer_ledger (customer_id, entry_type, amount, ref_id, balance_after, created_at) values ($1,'invoice',$2,$3,$4,$5)`,
        [customerId, subtotal, inv.id, balance[e.key], tReady]);
      const steps = [[null, 'draft', t, userId], ['draft', 'submitted', t, userId], ['submitted', 'approved', new Date(t.getTime() + 30 * 60000), staffId],
        ['approved', 'picking', new Date(t.getTime() + 30 * 60000), staffId], ['picking', 'ready', tReady, staffId]];
      if (e.status === 'collected') steps.push(['ready', 'collected', tCollected, staffId]);
      for (const [from, to, at, by] of steps) {
        await c.query('insert into order_status_history (order_id, from_status, to_status, changed_by, created_at) values ($1,$2,$3,$4,$5)', [order.id, from, to, by, at]);
      }
    }
    for (const [key, b] of Object.entries(balance)) await c.query('update customers set balance = $2 where id = $1', [cust[key], b]);
    console.log('Seeded. Balances:', Object.fromEntries(Object.entries(balance).map(([k, v]) => [k, Math.round(v * 100) / 100])));
  });
  console.log('Logins (password = SEED_PASSWORD from .env): owner 9000000001, staff 9000000002, customers 9000000101/102/103');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
