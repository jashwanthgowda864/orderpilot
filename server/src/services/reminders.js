import { pool } from '../db.js';
import { config } from '../config.js';
import { conflict, notFound } from '../middleware/error.js';
import { draftPaymentReminder } from './gemini.js';

const SUPPORTED = new Set(['en', 'kn', 'hi']);

function fmtAmount(amount) {
  return Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDateInShopTz(date) {
  if (!date) return null;
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: config.shopTimezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function dateNumericTokens(date) {
  if (!date) return [];
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.shopTimezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return [
    byType.day,
    String(Number(byType.day)),
    byType.month,
    String(Number(byType.month)),
    byType.year,
  ].filter(Boolean);
}

export function buildTemplateReminder({ shopName, amount, lastPaymentAt, language }) {
  const amt = fmtAmount(amount);
  const dateStr = fmtDateInShopTz(lastPaymentAt);
  if (language === 'kn') {
    return dateStr
      ? `ನಮಸ್ಕಾರ, ${shopName} ನಿಂದ ಸೌಜನ್ಯಯುತ ನೆನಪು: ನಿಮ್ಮ ಬಾಕಿ ಮೊತ್ತ ₹${amt} ಆಗಿದೆ (ಕೊನೆಯ ಪಾವತಿ ${dateStr}). ದಯವಿಟ್ಟು ಅನುಕೂಲವಾದಾಗ ಪಾವತಿಸಿ. ಧನ್ಯವಾದಗಳು.`
      : `ನಮಸ್ಕಾರ, ${shopName} ನಿಂದ ಸೌಜನ್ಯಯುತ ನೆನಪು: ನಿಮ್ಮ ಬಾಕಿ ಮೊತ್ತ ₹${amt} ಆಗಿದೆ (ಇನ್ನೂ ಯಾವುದೇ ಪಾವತಿ ಸ್ವೀಕರಿಸಲಾಗಿಲ್ಲ). ದಯವಿಟ್ಟು ಅನುಕೂಲವಾದಾಗ ಪಾವತಿಸಿ. ಧನ್ಯವಾದಗಳು.`;
  }
  if (language === 'hi') {
    return dateStr
      ? `नमस्ते, ${shopName} की ओर से विनम्र अनुस्मारक: आपकी बकाया राशि ₹${amt} है (अंतिम भुगतान ${dateStr})। कृपया सुविधा अनुसार भुगतान करें। धन्यवाद।`
      : `नमस्ते, ${shopName} की ओर से विनम्र अनुस्मारक: आपकी बकाया राशि ₹${amt} है (अभी तक कोई भुगतान प्राप्त नहीं हुआ है)। कृपया सुविधा अनुसार भुगतान करें। धन्यवाद।`;
  }
  return dateStr
    ? `Hello from ${shopName}. Friendly reminder: your outstanding balance is ₹${amt} (last payment on ${dateStr}). Please settle at your convenience. Thank you.`
    : `Hello from ${shopName}. Friendly reminder: your outstanding balance is ₹${amt} (no payment received yet). Please settle at your convenience. Thank you.`;
}

export function isSafeReminderText(text, { amount, lastPaymentAt }) {
  if (!text || typeof text !== 'string' || text.length > 400) return false;
  if (/https?:\/\/|www\.|@/i.test(text)) return false;

  const normalized = text.replace(/(?<=\d),(?=\d)/g, '');
  const runs = normalized.match(/\d+(?:\.\d+)?/g) || [];

  const numAmt = Number(amount);
  const allowedAmt = new Set([String(numAmt), numAmt.toFixed(2)]);
  if (Number.isInteger(numAmt)) allowedAmt.add(String(Math.round(numAmt)));

  const allowed = new Set([...allowedAmt, ...dateNumericTokens(lastPaymentAt)]);
  if (!runs.some((r) => allowedAmt.has(r))) return false;
  return runs.every((r) => allowed.has(r));
}

export async function createReminderDraft({ customerId, userId }) {
  const { rows: custRows } = await pool.query(
    'select id, balance, preferred_language from customers where id = $1',
    [customerId],
  );
  const customer = custRows[0];
  if (!customer) throw notFound('Customer not found.');
  const amount = Math.round(Number(customer.balance) * 100) / 100;
  if (!(amount > 0)) throw conflict('Nothing outstanding.');

  const [payRes, orderRes, shopRes] = await Promise.all([
    pool.query('select created_at from payments where customer_id = $1 order by created_at desc limit 1', [customerId]),
    pool.query(
      `select language from orders where customer_id = $1 and language in ('en','kn','hi')
       order by created_at desc limit 1`,
      [customerId],
    ),
    pool.query('select name from shop_settings where id = 1'),
  ]);

  const lastPaymentAt = payRes.rows[0]?.created_at || null;
  const language = SUPPORTED.has(customer.preferred_language)
    ? customer.preferred_language
    : SUPPORTED.has(orderRes.rows[0]?.language)
      ? orderRes.rows[0].language
      : 'en';
  const shopName = shopRes.rows[0]?.name || 'OrderPilot Shop';

  const fallbackText = buildTemplateReminder({ shopName, amount, lastPaymentAt, language });
  const lastPaymentDateStr = fmtDateInShopTz(lastPaymentAt);

  let text = fallbackText;
  let source = 'template';

  try {
    const res = await draftPaymentReminder({
      shopName,
      amount,
      lastPaymentDate: lastPaymentDateStr || 'none',
      language,
      fallbackText,
      userId,
    });
    if (!config.gemini.mock && isSafeReminderText(res.text, { amount, lastPaymentAt })) {
      text = res.text;
      source = 'ai';
    }
  } catch {
    // Always fall back to the safe fixed template on any AI failure.
  }

  return {
    text,
    language,
    amount,
    last_payment_date: lastPaymentAt ? new Date(lastPaymentAt).toISOString().slice(0, 10) : null,
    source,
  };
}
