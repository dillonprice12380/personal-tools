import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);

/** Wraps an async handler so rejected promises reach the error middleware. */
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Coerce JSON booleans to SQLite ints; leave everything else alone. */
export function sqlValue(v: unknown) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v as any;
}

/** Pick only the allowed columns present in the body. */
export function pick(body: Record<string, any>, columns: string[]) {
  const out: Record<string, any> = {};
  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(body, col)) out[col] = sqlValue(body[col]);
  }
  return out;
}

export function requireFields(body: Record<string, any>, fields: string[]) {
  const missing = fields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === ''
  );
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
}

export function toInt(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
