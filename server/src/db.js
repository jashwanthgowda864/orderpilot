import pg from 'pg';
import { config } from './config.js';

// Return NUMERIC as JS numbers (values here are money/quantities well within double precision).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// BIGINT (identity columns like order_no) as numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run fn(client) inside a single transaction. Rolls back on any error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
