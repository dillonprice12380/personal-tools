import type BetterSqlite3 from 'better-sqlite3';

/**
 * Additive schema migrations.
 *
 * The table definitions in schema.ts use CREATE TABLE IF NOT EXISTS, which
 * creates missing tables but never alters existing ones. A database created by
 * an earlier version therefore keeps its old column set. Each entry below adds
 * one column if it is not already present, so upgrading in place never loses
 * data and never needs a rebuild.
 *
 * Only additive changes belong here. Anything destructive should be a
 * deliberate, separately reviewed step.
 */
type ColumnMigration = { table: string; column: string; definition: string };

const COLUMNS: ColumnMigration[] = [
  // Google Search Console linkage, added after the initial release.
  { table: 'seo_sites', column: 'gsc_property', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'seo_sites', column: 'gsc_credential_id', definition: 'INTEGER' },
  { table: 'seo_sites', column: 'authority_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  // Where a tracked keyword came from: typed in, or discovered via GSC.
  { table: 'seo_keywords', column: 'source', definition: "TEXT NOT NULL DEFAULT 'manual'" },
  // Link health for catalogued courses, added with the bulk importer.
  { table: 'learning_resources', column: 'checked_at', definition: 'TEXT' },
  { table: 'learning_resources', column: 'check_status', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

function columnExists(db: BetterSqlite3.Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    // The table itself does not exist yet; schema.ts will create it complete.
    return true;
  }
}

export function runMigrations(db: BetterSqlite3.Database): string[] {
  const applied: string[] = [];
  for (const m of COLUMNS) {
    if (columnExists(db, m.table, m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
    applied.push(`${m.table}.${m.column}`);
  }
  return applied;
}
