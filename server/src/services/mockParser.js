// Deterministic stand-in for Gemini when no API key is configured. It only
// understands typed text; photos and voice notes get a clarification asking the
// customer to type the items.
import { normalizeUnit, rankProducts, toSellableUnits } from './catalogMatch.js';

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, dozen: 12 };
const UNIT_RE = '(kg|kgs|kilo|kilos|g|gm|gms|grams?|l|ltrs?|litres?|liters?|ml|pcs|pc|pieces?|packets?|packs?|pkts?|bottles?|box(?:es)?|bags?|dozen|doz)';

function parseSegment(seg) {
  let s = seg.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [w, n] of Object.entries(NUMBER_WORDS)) s = s.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  let m = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}?\\b\\s*(?:of\\s+)?(.+)$`));
  if (m) return { quantity: Number(m[1]), unit: m[2] || null, name: m[3] };
  m = s.match(new RegExp(`^(.+?)\\s*[-:x×*]?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}?$`));
  if (m) return { quantity: Number(m[2]), unit: m[3] || null, name: m[1] };
  return { quantity: null, unit: null, name: s };
}

// Phrases that refer to an earlier order (feature 1), in English, Kannada and Hindi.
const PREVIOUS_RE = /\b(my\s+)?(usual(\s+order)?|same\s+(as\s+)?(last|before|previous)(\s+(time|week|order))?|same\s+again|last\s+order|repeat(\s+(my|the))?(\s+last)?(\s+order)?|previous\s+order)\b|ಹಿಂದಿನ(\s*ಸಲದ)?(\s*ಹಾಗೆ)?|पिछल[ाीे](\s*बार)?(\s*वाला)?|वही\s*वाला/giu;
const REMOVE_RE = /^(no|without|minus|remove|except|but\s+no)\s+/i;

function matchSegment(seg, catalog) {
  const parsed = parseSegment(seg);
  if (!parsed.name || parsed.name.length < 2) return null;
  const ranked = rankProducts(parsed.name, catalog, 3);
  const top = ranked[0];
  const tie = ranked[1] && top && ranked[1].score >= top.score - 0.05 && top.score < 1;
  let sku = null; let confidence = "low"; let candidates = ranked.map((r) => r.p.sku);
  if (top && !tie && top.score >= 0.34) {
    sku = top.p.sku;
    confidence = top.score >= 0.99 ? "high" : top.score >= 0.6 ? "medium" : "low";
    candidates = [];
  }
  let quantity = parsed.quantity;
  const product = sku ? catalog.find((p) => p.sku === sku) : null;
  if (quantity != null && product && parsed.unit) quantity = toSellableUnits(quantity, parsed.unit, product);
  return {
    sku, name: product ? product.name : parsed.name, quantity: quantity && quantity > 0 ? quantity : null,
    unit: normalizeUnit(parsed.unit) || product?.unit || null, confidence, candidates, from_previous: false,
    source_text: seg.trim().slice(0, 300) || null,
  };
}

export function mockParseOrder({ text, hasFile, catalog, previousOrder }) {
  if (!text || !text.trim()) {
    return {
      language: "en",
      transcript: null,
      items: [],
      refers_to_previous: false,
      questions: [{ question: hasFile
        ? "Demo mode cannot read photos or voice notes. Please type your items (for example \"2 kg sugar, 1 Amul butter\")."
        : "What would you like to order?" }],
    };
  }
  const refers = new RegExp(PREVIOUS_RE.source, "iu").test(text);
  const rest = refers ? text.replace(PREVIOUS_RE, " ") : text;
  const segments = rest.split(/\n|,|;|\+|&|\band\b|\bplus\b|\bwith\b|\balso\b|(?:^|\s)(?:और|तथा|ಮತ್ತು)(?=\s|$)/iu)
    .map((x) => (x || '').trim()).filter(Boolean);

  const added = []; const removed = new Set();
  for (const seg of segments.slice(0, 100)) {
    if (REMOVE_RE.test(seg)) {
      const m = matchSegment(seg.replace(REMOVE_RE, ""), catalog);
      if (m?.sku) removed.add(m.sku);
      continue;
    }
    if (refers && /^(please|pls|send|give|same|order|the|again)$/i.test(seg)) continue;
    const m = matchSegment(seg, catalog);
    if (m) added.push(m);
  }

  let items = added;
  if (refers && previousOrder?.items?.length) {
    const bySku = new Map();
    for (const p of previousOrder.items) {
      const product = catalog.find((c) => c.sku === p.sku);
      bySku.set(p.sku, { sku: p.sku, name: product ? product.name : p.name, quantity: Number(p.quantity),
        unit: product?.unit || null, confidence: "high", candidates: [], from_previous: true, source_text: null });
    }
    const extra = [];
    for (const a of added) {
      if (a.sku && bySku.has(a.sku)) {
        const line = bySku.get(a.sku);
        line.quantity += a.quantity ?? 1; // "plus 2 sugar"
        line.source_text = a.source_text || line.source_text;
      } else extra.push(a);
    }
    items = [...bySku.values(), ...extra];
  }
  items = items.filter((i) => !i.sku || !removed.has(i.sku));
  return { language: /[\u0C80-\u0CFF]/.test(text) ? "kn" : /[\u0900-\u097F]/.test(text) ? "hi" : "en",
    transcript: null, items, questions: [], refers_to_previous: refers };
}

function detectLanguage(text) {
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}

function detectPeriod(q) {
  if (/\byesterday\b/.test(q)) return 'yesterday';
  if (/\bthis\s+week\b/.test(q)) return 'this_week';
  if (/\blast\s+7\s+days\b|\bpast\s+7\s+days\b|\bpast\s+week\b/.test(q)) return 'last_7_days';
  if (/\bthis\s+month\b/.test(q)) return 'this_month';
  if (/\blast\s+30\s+days\b|\bpast\s+30\s+days\b/.test(q)) return 'last_30_days';
  if (/\blast\s+month\b|\bprevious\s+month\b/.test(q)) return 'last_month';
  if (/\btoday\b/.test(q)) return 'today';
  return null;
}

export function mockClassifyBusinessQuestion({ question, hasFile }) {
  if (!question || !question.trim()) {
    return { intent: 'unknown', period: null, product: null, customer: null, limit: null, language: 'en', transcript: hasFile ? null : null };
  }
  const text = question.trim();
  const q = text.toLowerCase();
  const language = detectLanguage(text);
  const period = detectPeriod(q);
  const limitMatch = q.match(/\btop\s+(\d+)\b/);
  const limit = limitMatch ? Math.min(10, Math.max(1, Number(limitMatch[1]))) : null;

  if (/\b(low\s+stock|reorder|running\s+low|out\s+of\s+stock)\b/.test(q)) {
    return { intent: 'low_stock', period: null, product: null, customer: null, limit: null, language, transcript: null };
  }
  if (/\b(who\s+owes|top\s+outstanding|highest\s+balance|most\s+outstanding|owe\s+the\s+most|owes\s+(the\s+)?most)\b/.test(q)) {
    return { intent: 'top_outstanding_customers', period: null, product: null, customer: null, limit, language, transcript: null };
  }
  if (/\b(balance|how\s+much\s+(does\s+)?[a-z]+\s+owe|due\s+from)\b/.test(q)) {
    const m = q.match(/(?:balance\s+(?:of|for)\s+|how\s+much\s+(?:does\s+)?|due\s+from\s+)([a-z][a-z\s]{1,40}?)(?:\s+owe|\s*\?|$)/i)
      || q.match(/^([a-z][a-z\s]{1,40}?)\s+balance\b/i);
    const customer = m ? m[1].trim() : null;
    if (customer) {
      return { intent: 'customer_balance', period: null, product: null, customer, limit: null, language, transcript: null };
    }
  }
  if (/\b(top\s+(\d+\s+)?products?|best\s+sell|top\s+sell)\b/.test(q)) {
    return { intent: 'top_products', period, product: null, customer: null, limit, language, transcript: null };
  }
  if (/\b(orders?\s+by\s+status|order\s+status|how\s+many\s+orders|pending\s+orders)\b/.test(q)) {
    return { intent: 'orders_by_status', period, product: null, customer: null, limit: null, language, transcript: null };
  }
  const prodSales = q.match(/(?:sales\s+(?:of|for)\s+|how\s+much\s+|sold\s+(?:of\s+)?)([a-z0-9][a-z0-9\s]{1,50}?)(?:\s+(?:sold|today|yesterday|this\s+week|this\s+month|last\s+\d+\s+days|last\s+month)|[?]|$)/i);
  if (prodSales && !/\b(total|all|overall|store|shop)\b/.test(prodSales[1]) && (/\bsales\s+(?:of|for)\b/.test(q) || /\bsold\b/.test(q))) {
    return { intent: 'sales_by_product', period, product: prodSales[1].trim(), customer: null, limit: null, language, transcript: null };
  }
  if (/\b(sales|revenue|turnover|total\s+billing|invoices?)\b/.test(q)) {
    return { intent: 'sales_by_period', period, product: null, customer: null, limit: null, language, transcript: null };
  }
  return { intent: 'unknown', period: null, product: null, customer: null, limit: null, language, transcript: null };
}

export function mockParseSupplierBill({ catalog }) {
  const sugar = catalog.find((p) => p.sku === 'SUGAR-1KG') || catalog[0];
  const lines = [];
  if (sugar) {
    lines.push({
      sku: sugar.sku,
      name: `${sugar.name} (bulk)`,
      quantity: 20,
      unit: sugar.unit,
      unit_price: Math.round(Number(sugar.price) * 0.85 * 100) / 100,
      line_total: Math.round(Number(sugar.price) * 0.85 * 20 * 100) / 100,
    });
  }
  lines.push({
    sku: null,
    name: 'Organic Jaggery (unmatched sample)',
    quantity: 10,
    unit: 'kg',
    unit_price: 55,
    line_total: 550,
  });
  const total = Math.round(lines.reduce((s, l) => s + (l.line_total || 0), 0) * 100) / 100;
  return {
    supplier_name: 'Sri Ganesh Wholesale',
    bill_number: `DEMO-${Date.now().toString().slice(-4)}`,
    bill_date: new Date().toISOString().slice(0, 10),
    total,
    lines,
  };
}
