import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code; // stable machine-readable code for the client, e.g. 'ai_busy'
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const forbidden = (msg = 'You do not have permission to do this.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found.' });
}

// Postgres error codes we translate into client errors.
const PG_ERRORS = {
  '23505': [409, 'This record already exists.'],
  '23503': [400, 'A referenced record does not exist.'],
  '23514': [400, 'A value is outside the allowed range.'],
  '22P02': [400, 'Invalid identifier format.'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details, code: err.code });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid input.', details: formatZod(err) });
  }
  if (err?.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Invalid upload.';
    return res.status(400).json({ error: msg });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  if (err?.code && PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code];
    return res.status(status).json({ error: message });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

export function formatZod(err) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
