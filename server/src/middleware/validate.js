import { badRequest, formatZod } from './error.js';

/**
 * validate({ body, query, params }) — each a Zod schema (use strict objects so
 * unknown fields are rejected). Parsed values are placed on req.valid.
 */
export function validate(schemas) {
  return (req, res, next) => {
    req.valid = req.valid || {};
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const result = schemas[key].safeParse(req[key] ?? {});
      if (!result.success) return next(badRequest('Invalid input.', formatZod(result.error)));
      req.valid[key] = result.data;
    }
    next();
  };
}
