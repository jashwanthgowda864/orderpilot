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
        unit: product?.unit || null, confidence: "high", candidates: [], from_previous: true });
    }
    const extra = [];
    for (const a of added) {
      if (a.sku && bySku.has(a.sku)) bySku.get(a.sku).quantity += a.quantity ?? 1; // "plus 2 sugar"
      else extra.push(a);
    }
    items = [...bySku.values(), ...extra];
  }
  items = items.filter((i) => !i.sku || !removed.has(i.sku));
  return { language: /[\u0C80-\u0CFF]/.test(text) ? "kn" : /[\u0900-\u097F]/.test(text) ? "hi" : "en",
    transcript: null, items, questions: [], refers_to_previous: refers };
}
