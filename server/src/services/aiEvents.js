import { query } from '../db.js';

/**
 * Logs every model call. Runs on the pool (not inside the caller's transaction)
 * so failures are still recorded when the business transaction rolls back.
 * Never throws: logging must not break the request.
 */
export async function logAiEvent(e) {
  try {
    await query(
      `insert into ai_events (kind, status, model, mock, user_id, order_id, input_summary, output, error, latency_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.kind, e.status, e.model ?? null, Boolean(e.mock), e.userId ?? null, e.orderId ?? null,
        e.inputSummary ? String(e.inputSummary).slice(0, 500) : null,
        e.output === undefined ? null : JSON.stringify(e.output),
        e.error ? String(e.error).slice(0, 1000) : null,
        e.latencyMs ?? null,
      ],
    );
  } catch (err) {
    console.error('[ai_events] failed to log:', err.message);
  }
}
