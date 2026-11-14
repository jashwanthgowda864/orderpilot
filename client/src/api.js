// Thin fetch wrapper. The JWT is the only credential the browser holds.
const TOKEN_KEY = 'orderpilot.token';

export class ApiError extends Error {
  constructor(status, message, details, code) { super(message); this.status = status; this.details = details; this.code = code; }
}

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export async function api(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.blob();
  if (res.status === 401 && token) window.dispatchEvent(new Event('orderpilot:unauthorized'));
  if (!res.ok) {
    const details = data?.details;
    const extra = Array.isArray(details) && details[0]?.message ? ` (${details.map((d) => d.message).join('; ')})` : '';
    throw new ApiError(res.status, (data?.error || `Request failed (${res.status})`) + extra, details, data?.code);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
