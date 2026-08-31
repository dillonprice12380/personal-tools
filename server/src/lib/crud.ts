import { Router } from 'express';
import type { Request } from 'express';
import { all, get, logActivity, run } from '../db.js';
import { HttpError, notFound, pick, requireFields, toInt, wrap } from './http.js';

export type CrudOptions<T = any> = {
  /** SQL table name (also used as the activity-log entity type). */
  table: string;
  /** Columns a client is allowed to write. Anything else in the body is ignored. */
  columns: string[];
  /** Columns that must be present and non-empty on create. */
  required?: string[];
  /** Columns filterable by exact match via query string. */
  filters?: string[];
  /** Columns scanned by the `?q=` free-text filter. */
  search?: string[];
  /** Default ORDER BY clause. */
  orderBy?: string;
  /** Columns allowed in `?order=col.dir`. Defaults to `columns` + id/created_at. */
  sortable?: string[];
  /** Extra SQL appended to WHERE, with params, computed per request. */
  scope?: (req: Request) => { sql: string; params: any[] } | null;
  /** Transform a row on the way out (e.g. parse JSON columns, add computed fields). */
  hydrate?: (row: any) => T;
  /** Mutate/validate the payload before an insert or update. */
  beforeWrite?: (data: Record<string, any>, req: Request, existing?: any) => void;
  /** Fired after a successful insert/update/delete. */
  afterWrite?: (row: any, action: 'create' | 'update' | 'delete', req: Request) => void;
  /** Human-readable label for the activity log. */
  describe?: (row: any) => string;
  /** Disable individual verbs when a module needs custom handling. */
  disable?: Array<'list' | 'read' | 'create' | 'update' | 'delete'>;
};

function buildWhere(req: Request, opts: CrudOptions) {
  const clauses: string[] = [];
  const params: any[] = [];

  for (const col of opts.filters ?? []) {
    const raw = req.query[col];
    if (raw === undefined || raw === '') continue;
    if (typeof raw === 'string' && raw.includes(',')) {
      const vals = raw.split(',').filter(Boolean);
      clauses.push(`${col} IN (${vals.map(() => '?').join(',')})`);
      params.push(...vals);
    } else if (raw === 'null') {
      clauses.push(`${col} IS NULL`);
    } else {
      clauses.push(`${col} = ?`);
      params.push(raw);
    }
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q && opts.search?.length) {
    clauses.push(`(${opts.search.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    for (const _ of opts.search) params.push(`%${q}%`);
  }

  const scope = opts.scope?.(req);
  if (scope) {
    clauses.push(scope.sql);
    params.push(...scope.params);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function buildOrder(req: Request, opts: CrudOptions) {
  const allowed = new Set(opts.sortable ?? [...opts.columns, 'id', 'created_at', 'updated_at']);
  const raw = typeof req.query.order === 'string' ? req.query.order : '';
  if (raw) {
    const [col, dir] = raw.split('.');
    if (allowed.has(col)) {
      return `ORDER BY ${col} ${dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }
  }
  return opts.orderBy ? `ORDER BY ${opts.orderBy}` : 'ORDER BY id DESC';
}

/**
 * Generates REST endpoints for a table. Column names are never taken from user
 * input - they come from the `columns`/`filters` allowlists in the route
 * definition - so the interpolation below cannot be used for injection.
 */
export function crud<T = any>(opts: CrudOptions<T>): Router {
  const router = Router();
  const disabled = new Set(opts.disable ?? []);
  const out = (row: any) => (row && opts.hydrate ? opts.hydrate(row) : row);

  const readOne = (id: number) => get(`SELECT * FROM ${opts.table} WHERE id = ?`, [id]);

  if (!disabled.has('list')) {
    router.get(
      '/',
      wrap((req, res) => {
        const where = buildWhere(req, opts);
        const order = buildOrder(req, opts);
        const limit = Math.min(toInt(req.query.limit, 200) || 200, 1000);
        const offset = toInt(req.query.offset, 0);
        const rows = all(
          `SELECT * FROM ${opts.table} ${where.sql} ${order} LIMIT ? OFFSET ?`,
          [...where.params, limit, offset]
        );
        const total = get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${opts.table} ${where.sql}`,
          where.params
        );
        res.json({ items: rows.map(out), total: total?.n ?? rows.length, limit, offset });
      })
    );
  }

  if (!disabled.has('read')) {
    router.get(
      '/:id',
      wrap((req, res) => {
        const row = readOne(toInt(req.params.id));
        if (!row) throw notFound(opts.table);
        res.json(out(row));
      })
    );
  }

  if (!disabled.has('create')) {
    router.post(
      '/',
      wrap((req, res) => {
        const body = { ...(req.body ?? {}) };
        opts.beforeWrite?.(body, req);
        if (opts.required?.length) requireFields(body, opts.required);
        const data = pick(body, opts.columns);
        const cols = Object.keys(data);
        if (!cols.length) throw new HttpError(400, 'No writable fields supplied');
        const info = run(
          `INSERT INTO ${opts.table} (${cols.join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => data[c])
        );
        const row = readOne(Number(info.lastInsertRowid));
        logActivity(opts.table, Number(info.lastInsertRowid), 'create', opts.describe?.(row) ?? '');
        opts.afterWrite?.(row, 'create', req);
        res.status(201).json(out(row));
      })
    );
  }

  if (!disabled.has('update')) {
    const update = wrap((req, res) => {
      const id = toInt(req.params.id);
      const existing = readOne(id);
      if (!existing) throw notFound(opts.table);
      const body = { ...(req.body ?? {}) };
      opts.beforeWrite?.(body, req, existing);
      const data = pick(body, opts.columns);
      const cols = Object.keys(data);
      if (cols.length) {
        run(
          `UPDATE ${opts.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
          [...cols.map((c) => data[c]), id]
        );
      }
      const row = readOne(id);
      logActivity(opts.table, id, 'update', opts.describe?.(row) ?? '');
      opts.afterWrite?.(row, 'update', req);
      res.json(out(row));
    });
    router.patch('/:id', update);
    router.put('/:id', update);
  }

  if (!disabled.has('delete')) {
    router.delete(
      '/:id',
      wrap((req, res) => {
        const id = toInt(req.params.id);
        const row = readOne(id);
        if (!row) throw notFound(opts.table);
        run(`DELETE FROM ${opts.table} WHERE id = ?`, [id]);
        logActivity(opts.table, id, 'delete', opts.describe?.(row) ?? '');
        opts.afterWrite?.(row, 'delete', req);
        res.status(204).end();
      })
    );
  }

  return router;
}
