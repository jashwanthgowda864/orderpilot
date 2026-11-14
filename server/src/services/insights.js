import { pool } from '../db.js';
import { config } from '../config.js';
import { classifyBusinessQuestion } from './gemini.js';
import { rankProducts } from './catalogMatch.js';

export const UNKNOWN_ANSWER = 'I can answer questions about: sales by period, sales of a product, top products, who owes the most, a customer\'s balance, low stock, orders by status.';

const PERIOD_LABELS = {
  en: {
    today: 'today',
    yesterday: 'yesterday',
    this_week: 'this week',
    last_7_days: 'the last 7 days',
    this_month: 'this month',
    last_30_days: 'the last 30 days',
    last_month: 'last month',
  },
  kn: {
    today: 'ಇಂದು',
    yesterday: 'ನಿನ್ನೆ',
    this_week: 'ಈ ವಾರ',
    last_7_days: 'ಕಳೆದ 7 ದಿನಗಳು',
    this_month: 'ಈ ತಿಂಗಳು',
    last_30_days: 'ಕಳೆದ 30 ದಿನಗಳು',
    last_month: 'ಕಳೆದ ತಿಂಗಳು',
  },
  hi: {
    today: 'आज',
    yesterday: 'कल',
    this_week: 'इस सप्ताह',
    last_7_days: 'पिछले 7 दिन',
    this_month: 'इस महीने',
    last_30_days: 'पिछले 30 दिन',
    last_month: 'पिछले महीने',
  },
};

const fmtMoney = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function langOf(l) {
  return l === 'kn' || l === 'hi' ? l : 'en';
}

function periodLabel(period, lang) {
  return PERIOD_LABELS[lang]?.[period] || PERIOD_LABELS.en[period] || period;
}

/**
 * Returns { sql, params } for filtering a timestamptz column `col` in config.shopTimezone.
 */
function periodWhere(col, period) {
  const tz = config.shopTimezone;
  const todayStart = `(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
  const weekStart = `(date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
  const monthStart = `(date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
  switch (period) {
    case 'today':
      return { clause: `${col} >= ${todayStart}`, params: [tz] };
    case 'yesterday':
      return { clause: `${col} >= ${todayStart} - interval '1 day' and ${col} < ${todayStart}`, params: [tz] };
    case 'this_week':
      return { clause: `${col} >= ${weekStart}`, params: [tz] };
    case 'last_7_days':
      return { clause: `${col} >= ${todayStart} - interval '7 days'`, params: [tz] };
    case 'this_month':
      return { clause: `${col} >= ${monthStart}`, params: [tz] };
    case 'last_30_days':
      return { clause: `${col} >= ${todayStart} - interval '30 days'`, params: [tz] };
    case 'last_month':
      return { clause: `${col} >= ${monthStart} - interval '1 month' and ${col} < ${monthStart}`, params: [tz] };
    default:
      return null;
  }
}

async function handleSalesByPeriod(period, lang) {
  const p = period || 'today';
  const pw = periodWhere('created_at', p);
  const { rows } = await pool.query(
    `select coalesce(sum(total), 0) as total, count(*)::int as count from invoices where ${pw.clause}`,
    pw.params,
  );
  const { total, count } = rows[0];
  const pLabel = periodLabel(p, lang);
  const answer = lang === 'kn'
    ? `${pLabel} ಮಾರಾಟ: ${fmtMoney(total)} (${fmtNum(count)} ಬಿಲ್‌ಗಳು).`
    : lang === 'hi'
      ? `${pLabel} की बिक्री: ${fmtMoney(total)} (${fmtNum(count)} बिल)।`
      : `Sales for ${pLabel}: ${fmtMoney(total)} across ${fmtNum(count)} invoice(s).`;
  return {
    answer,
    columns: ['Period', 'Invoices', 'Total'],
    rows: [[periodLabel(p, 'en'), count, Number(total)]],
  };
}

async function handleSalesByProduct(productQuery, period, lang) {
  if (!productQuery) {
    return {
      answer: lang === 'kn' ? 'ಯಾವ ಉತ್ಪನ್ನದ ಮಾರಾಟ ಬೇಕು ಎಂದು ತಿಳಿಸಿ.'
        : lang === 'hi' ? 'कृपया उत्पाद का नाम बताएं।'
          : 'Which product would you like sales for?',
      columns: [],
      rows: [],
    };
  }
  const { rows: allProducts } = await pool.query(
    'select id, sku, name, name_kn, name_hi, aliases, unit, pack_size, price from products order by name',
  );
  const ranked = rankProducts(productQuery, allProducts, 3);
  if (!ranked.length || ranked[0].score < 0.34) {
    return {
      answer: lang === 'kn' ? `"${productQuery}" ಉತ್ಪನ್ನ ಕಂಡುಬಂದಿಲ್ಲ.`
        : lang === 'hi' ? `"${productQuery}" उत्पाद नहीं मिला।`
          : `Could not find a product matching "${productQuery}".`,
      columns: [],
      rows: [],
    };
  }
  const tie = ranked[1] && ranked[1].score >= ranked[0].score - 0.05 && ranked[0].score < 1;
  if (tie) {
    const names = ranked.map((r) => r.p.name).join(', ');
    return {
      answer: lang === 'kn' ? `ಯಾವ ಉತ್ಪನ್ನ? ${names}`
        : lang === 'hi' ? `आपका मतलब किस उत्पाद से है? ${names}`
          : `Multiple products match "${productQuery}": ${names}.`,
      columns: ['SKU', 'Product'],
      rows: ranked.map((r) => [r.p.sku, r.p.name]),
    };
  }

  const prod = ranked[0].p;
  const p = period || 'last_30_days';
  const pw = periodWhere('i.created_at', p);
  const { rows } = await pool.query(
    `select coalesce(sum((l->>'quantity')::numeric), 0) as qty,
            coalesce(sum((l->>'line_total')::numeric), 0) as total
     from invoices i, jsonb_array_elements(i.lines) as l
     where ${pw.clause} and l->>'sku' = $2`,
    [...pw.params, prod.sku],
  );
  const { qty, total } = rows[0];
  const pLabel = periodLabel(p, lang);
  const answer = lang === 'kn'
    ? `${pLabel} ${prod.name} ಮಾರಾಟ: ${fmtNum(qty)} ಪ್ಯಾಕ್ (${fmtMoney(total)}).`
    : lang === 'hi'
      ? `${pLabel} ${prod.name} की बिक्री: ${fmtNum(qty)} पैक (${fmtMoney(total)})।`
      : `${prod.name} sales for ${pLabel}: ${fmtNum(qty)} pack(s) totaling ${fmtMoney(total)}.`;
  return {
    answer,
    columns: ['SKU', 'Product', 'Qty', 'Sales'],
    rows: [[prod.sku, prod.name, Number(qty), Number(total)]],
  };
}

async function handleTopProducts(period, limit, lang) {
  const p = period || 'last_30_days';
  const lim = Math.min(10, Math.max(1, limit || 5));
  const pw = periodWhere('i.created_at', p);
  const { rows } = await pool.query(
    `select l->>'sku' as sku, max(l->>'name') as name,
            sum((l->>'quantity')::numeric) as qty,
            sum((l->>'line_total')::numeric) as total
     from invoices i, jsonb_array_elements(i.lines) as l
     where ${pw.clause}
     group by l->>'sku'
     order by total desc, qty desc
     limit $2`,
    [...pw.params, lim],
  );
  const pLabel = periodLabel(p, lang);
  if (!rows.length) {
    return {
      answer: lang === 'kn' ? `${pLabel} ಯಾವುದೇ ಮಾರಾಟ ದಾಖಲಾಗಿಲ್ಲ.`
        : lang === 'hi' ? `${pLabel} कोई बिक्री दर्ज नहीं हुई है।`
          : `No product sales recorded for ${pLabel}.`,
      columns: [],
      rows: [],
    };
  }
  const top = rows[0];
  const answer = lang === 'kn'
    ? `${pLabel} ಅತಿ ಹೆಚ್ಚು ಮಾರಾಟವಾದ ${fmtNum(rows.length)} ಉತ್ಪನ್ನಗಳು (ಮೊದಲನೆಯದು: ${top.name}, ${fmtMoney(top.total)}).`
    : lang === 'hi'
      ? `${pLabel} के शीर्ष ${fmtNum(rows.length)} उत्पाद (नंबर 1: ${top.name}, ${fmtMoney(top.total)})।`
      : `Top ${fmtNum(rows.length)} product(s) for ${pLabel} (led by ${top.name} at ${fmtMoney(top.total)}).`;
  return {
    answer,
    columns: ['SKU', 'Product', 'Qty', 'Sales'],
    rows: rows.map((r) => [r.sku, r.name, Number(r.qty), Number(r.total)]),
  };
}

async function handleTopOutstanding(limit, lang) {
  const lim = Math.min(10, Math.max(1, limit || 5));
  const { rows } = await pool.query(
    `select c.name, c.phone, c.balance,
            (select max(created_at) from payments p where p.customer_id = c.id) as last_payment_at
     from customers c
     where c.balance > 0
     order by c.balance desc, c.name
     limit $1`,
    [lim],
  );
  if (!rows.length) {
    return {
      answer: lang === 'kn' ? 'ಯಾವುದೇ ಗ್ರಾಹಕರ ಬಾಕಿ ಮೊತ್ತವಿಲ್ಲ.'
        : lang === 'hi' ? 'किसी भी ग्राहक पर कोई बकाया नहीं है।'
          : 'No customers currently have an outstanding balance.',
      columns: [],
      rows: [],
    };
  }
  const totalShown = rows.reduce((s, r) => s + Number(r.balance), 0);
  const top = rows[0];
  const answer = lang === 'kn'
    ? `ಅತಿ ಹೆಚ್ಚು ಬಾಕಿ ಇರುವ ${fmtNum(rows.length)} ಗ್ರಾಹಕರು (ಮೊದಲನೆಯದು: ${top.name}, ${fmtMoney(top.balance)}; ಒಟ್ಟು ${fmtMoney(totalShown)}).`
    : lang === 'hi'
      ? `सबसे अधिक बकाया वाले ${fmtNum(rows.length)} ग्राहक (शीर्ष: ${top.name}, ${fmtMoney(top.balance)}; कुल ${fmtMoney(totalShown)})।`
      : `Top ${fmtNum(rows.length)} outstanding customer(s) — highest is ${top.name} (${fmtMoney(top.balance)}).`;
  return {
    answer,
    columns: ['Customer', 'Phone', 'Balance', 'Last payment'],
    rows: rows.map((r) => [
      r.name,
      r.phone,
      Number(r.balance),
      r.last_payment_at ? new Date(r.last_payment_at).toISOString().slice(0, 10) : 'Never',
    ]),
  };
}

async function handleCustomerBalance(customerQuery, lang) {
  if (!customerQuery) {
    return {
      answer: lang === 'kn' ? 'ಯಾವ ಗ್ರಾಹಕರ ಬಾಕಿ ನೋಡಬೇಕು?'
        : lang === 'hi' ? 'किस ग्राहक का बकाया देखना है?'
          : 'Which customer would you like to check?',
      columns: [],
      rows: [],
    };
  }
  const { rows: all } = await pool.query(
    `select c.id, c.name, c.phone, c.balance,
            (select max(created_at) from payments p where p.customer_id = c.id) as last_payment_at
     from customers c order by c.name`,
  );
  const q = customerQuery.trim().toLowerCase();
  const matches = all.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q));
  if (!matches.length) {
    return {
      answer: lang === 'kn' ? `"${customerQuery}" ಗ್ರಾಹಕರು ಕಂಡುಬಂದಿಲ್ಲ.`
        : lang === 'hi' ? `"${customerQuery}" नाम का ग्राहक नहीं मिला।`
          : `No customer found matching "${customerQuery}".`,
      columns: [],
      rows: [],
    };
  }
  const exact = matches.find((c) => c.name.toLowerCase() === q);
  if (matches.length > 1 && !exact) {
    return {
      answer: lang === 'kn' ? `ಒಂದಕ್ಕಿಂತ ಹೆಚ್ಚು ಗ್ರಾಹಕರು ಸಿಕ್ಕಿದ್ದಾರೆ: ${matches.map((m) => m.name).join(', ')}.`
        : lang === 'hi' ? `एक से अधिक ग्राहक मिले: ${matches.map((m) => m.name).join(', ')}।`
          : `Multiple customers match "${customerQuery}": ${matches.map((m) => m.name).join(', ')}.`,
      columns: ['Customer', 'Phone', 'Balance'],
      rows: matches.map((m) => [m.name, m.phone, Number(m.balance)]),
    };
  }
  const c = exact || matches[0];
  const lastPay = c.last_payment_at ? new Date(c.last_payment_at).toISOString().slice(0, 10) : null;
  const answer = lang === 'kn'
    ? `${c.name} ಅವರ ಬಾಕಿ ಮೊತ್ತ: ${fmtMoney(c.balance)}${lastPay ? ` (ಕೊನೆಯ ಪಾವತಿ ${lastPay})` : ''}.`
    : lang === 'hi'
      ? `${c.name} का बकाया: ${fmtMoney(c.balance)}${lastPay ? ` (अंतिम भुगतान ${lastPay})` : ''}।`
      : `${c.name} has a balance of ${fmtMoney(c.balance)}${lastPay ? ` (last payment ${lastPay})` : ' (no payments recorded)'}.`;
  return {
    answer,
    columns: ['Customer', 'Phone', 'Balance', 'Last payment'],
    rows: [[c.name, c.phone, Number(c.balance), lastPay || 'Never']],
  };
}

async function handleLowStock(lang) {
  const { rows } = await pool.query(
    `select sku, name, stock_qty, reorder_level
     from products
     where active and stock_qty <= reorder_level
     order by stock_qty asc, name
     limit 25`,
  );
  if (!rows.length) {
    return {
      answer: lang === 'kn' ? 'ಕಡಿಮೆ ಸ್ಟಾಕ್ ಇರುವ ಉತ್ಪನ್ನಗಳು ಯಾವುವೂ ಇಲ್ಲ.'
        : lang === 'hi' ? 'कोई भी उत्पाद कम स्टॉक में नहीं है।'
          : 'No active products are at or below reorder level.',
      columns: [],
      rows: [],
    };
  }
  const answer = lang === 'kn'
    ? `${fmtNum(rows.length)} ಉತ್ಪನ್ನಗಳ ಸ್ಟಾಕ್ ಕಡಿಮೆ ಇದೆ.`
    : lang === 'hi'
      ? `${fmtNum(rows.length)} उत्पाद कम स्टॉक में हैं।`
      : `${fmtNum(rows.length)} product(s) are at or below reorder level.`;
  return {
    answer,
    columns: ['SKU', 'Product', 'Stock', 'Reorder at'],
    rows: rows.map((r) => [r.sku, r.name, Number(r.stock_qty), Number(r.reorder_level)]),
  };
}

async function handleOrdersByStatus(period, lang) {
  const pw = period ? periodWhere('created_at', period) : null;
  const { rows } = await pool.query(
    `select status, count(*)::int as count
     from orders ${pw ? `where ${pw.clause}` : ''}
     group by status
     order by count desc, status`,
    pw ? pw.params : [],
  );
  const total = rows.reduce((s, r) => s + r.count, 0);
  const pLabel = period ? periodLabel(period, lang) : null;
  const answer = lang === 'kn'
    ? `${pLabel ? `${pLabel} ` : ''}ಒಟ್ಟು ${fmtNum(total)} ಆರ್ಡರ್‌ಗಳು.`
    : lang === 'hi'
      ? `${pLabel ? `${pLabel} ` : ''}कुल ${fmtNum(total)} ऑर्डर।`
      : `${fmtNum(total)} total order(s)${pLabel ? ` for ${pLabel}` : ''}.`;
  return {
    answer,
    columns: ['Status', 'Count'],
    rows: rows.map((r) => [r.status, r.count]),
  };
}

export async function askBusiness({ question, file, userId }) {
  const classified = await classifyBusinessQuestion({ question, file, userId });
  const lang = langOf(classified.language);
  const params = {
    period: classified.period,
    product: classified.product,
    customer: classified.customer,
    limit: classified.limit,
  };

  let out;
  switch (classified.intent) {
    case 'sales_by_period':
      out = await handleSalesByPeriod(classified.period, lang);
      break;
    case 'sales_by_product':
      out = await handleSalesByProduct(classified.product, classified.period, lang);
      break;
    case 'top_products':
      out = await handleTopProducts(classified.period, classified.limit, lang);
      break;
    case 'top_outstanding_customers':
      out = await handleTopOutstanding(classified.limit, lang);
      break;
    case 'customer_balance':
      out = await handleCustomerBalance(classified.customer, lang);
      break;
    case 'low_stock':
      out = await handleLowStock(lang);
      break;
    case 'orders_by_status':
      out = await handleOrdersByStatus(classified.period, lang);
      break;
    default:
      out = { answer: UNKNOWN_ANSWER, columns: [], rows: [] };
      break;
  }

  return {
    intent: classified.intent,
    params,
    language: lang,
    transcript: classified.transcript,
    ...out,
  };
}
