// Central configuration. Secrets come only from environment variables (../.env),
// never from the client bundle.
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

const geminiKey = process.env.GEMINI_API_KEY || '';

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: (() => {
    const s = required('JWT_SECRET');
    if (s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
    return s;
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  gemini: {
    apiKey: geminiKey,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    // Mock mode when no key is set, or forced with GEMINI_MOCK=1.
    mock: !geminiKey || process.env.GEMINI_MOCK === '1',
    // Lighter model used when the main one is overloaded or failing. Empty = no fallback.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.1-flash-lite',
    // Per-attempt limit. Worst case before "AI is busy": 2 x main + 1 x fallback + backoff.
    // Main model gives up quickly so a slow/overloaded main model reaches the fast fallback sooner.
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 12000),
    fallbackTimeoutMs: Number(process.env.GEMINI_FALLBACK_TIMEOUT_MS || 30000),
    backoffMs: Number(process.env.GEMINI_BACKOFF_MS || 1500),
  },
  storage: {
    supabaseUrl: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucket: process.env.STORAGE_BUCKET || 'order-files',
    localDir: process.env.LOCAL_STORAGE_DIR || new URL('../.storage/', import.meta.url).pathname,
  },
  upload: {
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024),
  },
};
