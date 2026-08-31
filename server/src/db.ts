import Database from 'better-sqlite3';
import { config } from './config.js';
import { SCHEMA } from './schema.js';
import { runMigrations } from './migrations.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// Bring an older database up to the current column set before anything reads it.
const applied = runMigrations(db);
if (applied.length) console.log(`[helm] applied migrations: ${applied.join(', ')}`);

export type Row = Record<string, any>;

/** Rows for a query. */
export function all<T = Row>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** First row, or undefined. */
export function get<T = Row>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** A single scalar value from the first column of the first row. */
export function scalar<T = number>(sql: string, params: any[] = [], fallback?: T): T {
  const row = db.prepare(sql).get(...params) as Row | undefined;
  if (!row) return fallback as T;
  const v = Object.values(row)[0];
  return (v === null || v === undefined ? fallback : v) as T;
}

export function run(sql: string, params: any[] = []) {
  return db.prepare(sql).run(...params);
}

export function logActivity(
  entityType: string,
  entityId: number | null,
  action: string,
  summary = '',
  meta: Row = {}
) {
  run(
    `INSERT INTO activity (entity_type, entity_id, action, summary, meta_json)
     VALUES (?, ?, ?, ?, ?)`,
    [entityType, entityId, action, summary, JSON.stringify(meta)]
  );
}

/** Read a JSON setting. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)]
  );
}
