// Deterministic catalog matching and unit conversion. Used by the mock parser
// and by the server to suggest options when the model could not pick a SKU.

const UNIT_ALIASES = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kilogramme: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gr: 'g',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  ml: 'ml', pcs: 'pcs', pc: 'pcs', piece: 'pcs', pieces: 'pcs', nos: 'pcs', no: 'pcs',
  pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack', pkt: 'pack', pkts: 'pack',
  bottle: 'pack', bottles: 'pack', box: 'pack', boxes: 'pack', bag: 'pack', bags: 'pack',
  dozen: 'dozen', doz: 'dozen',
};
// unit -> [family, factor to family base]
const UNIT_BASE = { kg: ['mass', 1], g: ['mass', 0.001], l: ['vol', 1], ml: ['vol', 0.001], pcs: ['count', 1], dozen: ['count', 12], pack: ['pack', 1] };

export function normalizeUnit(u) {
  if (!u) return null;
  return UNIT_ALIASES[String(u).toLowerCase().replace(/\./g, '')] || null;
}

const STOP = new Set(['of', 'the', 'a', 'an', 'and', 'please', 'pls', 'need', 'want', 'some', 'give', 'me', 'x']);
export function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
}

function productTerms(p) {
  return [p.name, p.sku, p.name_kn, p.name_hi, ...(p.aliases || [])].filter(Boolean);
}

/** Score 0..1 of how well `query` matches product p. */
export function scoreProduct(query, p) {
  const q = tokens(query);
  if (!q.length) return 0;
  const qs = q.join(' ');
  let best = 0;
  for (const term of productTerms(p)) {
    const t = tokens(term);
    if (!t.length) continue;
    if (t.join(' ') === qs) return 1;
    const hits = q.filter((w) => t.some((tw) => tw === w || (w.length >= 4 && (tw.startsWith(w) || w.startsWith(tw))))).length;
    // Reward covering the query, lightly penalise long product names.
    const s = (hits / q.length) * (0.75 + 0.25 * Math.min(1, hits / t.length));
    if (s > best) best = s;
  }
  return best;
}

/** Top matches sorted by score. */
export function rankProducts(query, catalog, limit = 4) {
  return catalog
    .map((p) => ({ p, score: scoreProduct(query, p) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Converts an ordered amount into sellable units of product p.
 * "2 kg" of a 1 kg pack = 2; "500 g" of a 1 kg pack = 0.5 (caller decides if fractional is OK).
 */
export function toSellableUnits(amount, unit, p) {
  const u = normalizeUnit(unit);
  if (!u || u === 'pack') return amount;
  const [fam, f] = UNIT_BASE[u];
  const pu = UNIT_BASE[p.unit];
  if (!pu || pu[0] !== fam) return amount;
  return Math.round(((amount * f) / (p.pack_size * pu[1])) * 1000) / 1000;
}

/** Products sold by weight/volume with pack size 1 may be ordered in fractions. */
export function allowsFraction(p) {
  return (p.unit === 'kg' || p.unit === 'l') && Number(p.pack_size) === 1;
}
