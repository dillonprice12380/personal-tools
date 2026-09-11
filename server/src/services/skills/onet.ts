/**
 * O*NET importer.
 *
 * O*NET is the US Department of Labor's occupational database: roughly a
 * thousand occupations, each rated against the same set of skill, knowledge and
 * ability elements, with numeric importance and level values. That numeric
 * matrix is what lets Helm answer "what am I missing for this role" by
 * subtraction instead of by asking a model.
 *
 * Helm does not redistribute the data - it reads the files you download from
 * <https://www.onetcenter.org/database.html> (the tab-delimited "text" bundle).
 * O*NET is published under CC BY 4.0, so keep the attribution in docs/SKILLS.md
 * if you put this in front of anyone else.
 *
 * Files used, all optional - import what you have:
 *   Occupation Data.txt   role codes, titles, descriptions
 *   Skills.txt            the 35 cross-occupation skill elements
 *   Knowledge.txt         the 33 knowledge domains
 *   Abilities.txt         the 52 ability elements
 *   Technology Skills.txt concrete tooling, no ratings attached
 *
 * Columns are looked up by header name rather than by position, because the
 * column set has shifted between releases and a silent off-by-one column would
 * poison every number downstream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, run } from '../../db.js';
import { clampLevel } from './gap.js';

export type DelimitedTable = { headers: string[]; rows: Array<Record<string, string>> };

/**
 * Parse a tab-delimited O*NET export. Values are not quoted in these files, so
 * a full CSV parser would be more machinery than the format warrants; what does
 * matter is tolerating CRLF, a UTF-8 BOM and short trailing rows.
 */
export function parseDelimited(text: string, delimiter = '\t'): DelimitedTable {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(delimiter).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
  return { headers, rows };
}

/** Case- and punctuation-insensitive header lookup, so "O*NET-SOC Code" survives a rename. */
function column(table: DelimitedTable, ...candidates: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const candidate of candidates) {
    const target = norm(candidate);
    const hit = table.headers.find((h) => norm(h) === target);
    if (hit) return hit;
  }
  return null;
}

/** O*NET importance is 1-5. */
export function normaliseImportance(raw: number): number {
  return clampLevel(((raw - 1) / 4) * 100);
}

/** O*NET level is 0-7. */
export function normaliseLevel(raw: number): number {
  return clampLevel((raw / 7) * 100);
}

export type OccupationRow = { code: string; title: string; description: string };

export function parseOccupationData(text: string): OccupationRow[] {
  const table = parseDelimited(text);
  const codeCol = column(table, 'O*NET-SOC Code', 'onetsoccode', 'Code');
  const titleCol = column(table, 'Title');
  const descCol = column(table, 'Description');
  if (!codeCol || !titleCol) return [];
  return table.rows
    .filter((r) => r[codeCol] && r[titleCol])
    .map((r) => ({
      code: r[codeCol],
      title: r[titleCol],
      description: descCol ? r[descCol] ?? '' : '',
    }));
}

export type ElementRating = {
  code: string;
  elementId: string;
  elementName: string;
  importance: number | null;
  level: number | null;
};

/**
 * Parse Skills.txt / Knowledge.txt / Abilities.txt, which share a shape: one
 * row per (occupation, element, scale), where scale IM is importance and LV is
 * level. The two scales are folded back into a single row per pair.
 *
 * Rows flagged "Recommend Suppress" or "Not Relevant" are dropped - O*NET sets
 * those when the estimate is too thin to publish, and carrying them through
 * would put invented precision into a gap report.
 */
export function parseElementRatings(text: string): ElementRating[] {
  const table = parseDelimited(text);
  const codeCol = column(table, 'O*NET-SOC Code', 'onetsoccode');
  const idCol = column(table, 'Element ID');
  const nameCol = column(table, 'Element Name');
  const scaleCol = column(table, 'Scale ID');
  const valueCol = column(table, 'Data Value');
  if (!codeCol || !idCol || !scaleCol || !valueCol) return [];
  const suppressCol = column(table, 'Recommend Suppress');
  const notRelevantCol = column(table, 'Not Relevant');

  const merged = new Map<string, ElementRating>();
  for (const row of table.rows) {
    if (suppressCol && row[suppressCol]?.toUpperCase() === 'Y') continue;
    if (notRelevantCol && row[notRelevantCol]?.toUpperCase() === 'Y') continue;
    const code = row[codeCol];
    const elementId = row[idCol];
    const value = Number(row[valueCol]);
    if (!code || !elementId || !Number.isFinite(value)) continue;

    const key = `${code}|${elementId}`;
    const entry =
      merged.get(key) ??
      {
        code,
        elementId,
        elementName: nameCol ? row[nameCol] ?? elementId : elementId,
        importance: null,
        level: null,
      };
    const scale = row[scaleCol].toUpperCase();
    if (scale === 'IM') entry.importance = normaliseImportance(value);
    else if (scale === 'LV') entry.level = normaliseLevel(value);
    merged.set(key, entry);
  }
  return [...merged.values()];
}

export type TechnologyRow = { code: string; commodity: string; example: string; hot: boolean };

/**
 * Technology Skills.txt lists concrete tooling per occupation but carries no
 * importance or level ratings, so imported rows get defaults rather than
 * fabricated numbers: present-and-flagged-hot reads as more important than
 * present, and nothing more is claimed than that.
 */
export function parseTechnologySkills(text: string): TechnologyRow[] {
  const table = parseDelimited(text);
  const codeCol = column(table, 'O*NET-SOC Code', 'onetsoccode');
  const commodityCol = column(table, 'Commodity Title');
  const exampleCol = column(table, 'Example');
  const hotCol = column(table, 'Hot Technology');
  if (!codeCol || !commodityCol) return [];
  return table.rows
    .filter((r) => r[codeCol] && r[commodityCol])
    .map((r) => ({
      code: r[codeCol],
      commodity: r[commodityCol],
      example: exampleCol ? r[exampleCol] ?? '' : '',
      hot: hotCol ? r[hotCol]?.toUpperCase() === 'Y' : false,
    }));
}

// ------------------------------------------------------------------ write ---

const upsertSkill = (code: string, name: string, category: string, source: string, terms = '') => {
  run(
    `INSERT INTO skills (code, name, category, source, search_terms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, category = excluded.category, source = excluded.source`,
    [code, name, category, source, terms]
  );
  return db.prepare('SELECT id FROM skills WHERE code = ?').get(code) as { id: number };
};

const upsertOccupation = (code: string, title: string, description: string, source: string) => {
  run(
    `INSERT INTO occupations (code, title, description, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       title = excluded.title, description = excluded.description, source = excluded.source`,
    [code, title, description, source]
  );
  return db.prepare('SELECT id FROM occupations WHERE code = ?').get(code) as { id: number };
};

export type ImportReport = {
  files: string[];
  occupations: number;
  skills: number;
  requirements: number;
  skipped: string[];
};

const FILES = {
  occupations: 'Occupation Data.txt',
  skills: 'Skills.txt',
  knowledge: 'Knowledge.txt',
  abilities: 'Abilities.txt',
  technology: 'Technology Skills.txt',
};

function readIfPresent(dir: string, name: string): string | null {
  // O*NET ships these with spaces in the filename; some mirrors swap in
  // underscores, so try both before giving up on a file.
  for (const candidate of [name, name.replace(/ /g, '_')]) {
    const file = path.join(dir, candidate);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return null;
}

/**
 * Import an unpacked O*NET text bundle into the local skills database.
 *
 * Occupations can be restricted with `onlyCodes` - the full database is around
 * a thousand roles and 100k+ requirement rows, which imports fine but makes the
 * role picker unusable if you only ever wanted a handful.
 */
export function importOnet(options: {
  dir: string;
  onlyCodes?: string[];
  includeTechnology?: boolean;
}): ImportReport {
  const { dir, onlyCodes, includeTechnology = true } = options;
  if (!fs.existsSync(dir)) throw new Error(`O*NET directory not found: ${dir}`);

  const report: ImportReport = {
    files: [],
    occupations: 0,
    skills: 0,
    requirements: 0,
    skipped: [],
  };
  const wanted = onlyCodes?.length ? new Set(onlyCodes) : null;
  const keep = (code: string) => !wanted || wanted.has(code) || wanted.has(code.split('.')[0]);

  const occIds = new Map<string, number>();
  const skillIds = new Map<string, number>();

  const apply = db.transaction(() => {
    const occText = readIfPresent(dir, FILES.occupations);
    if (occText) {
      report.files.push(FILES.occupations);
      for (const occ of parseOccupationData(occText)) {
        if (!keep(occ.code)) continue;
        occIds.set(occ.code, upsertOccupation(occ.code, occ.title, occ.description, 'onet').id);
        report.occupations += 1;
      }
    } else {
      report.skipped.push(FILES.occupations);
    }

    // An occupation referenced by a ratings file but missing from Occupation
    // Data still gets a row, so its requirements are not silently dropped.
    const occupationId = (code: string) => {
      const known = occIds.get(code);
      if (known) return known;
      const id = upsertOccupation(code, code, '', 'onet').id;
      occIds.set(code, id);
      report.occupations += 1;
      return id;
    };

    const ratingFiles: Array<[string, string]> = [
      [FILES.skills, 'Skills'],
      [FILES.knowledge, 'Knowledge'],
      [FILES.abilities, 'Abilities'],
    ];

    for (const [file, category] of ratingFiles) {
      const text = readIfPresent(dir, file);
      if (!text) {
        report.skipped.push(file);
        continue;
      }
      report.files.push(file);
      for (const rating of parseElementRatings(text)) {
        if (!keep(rating.code)) continue;
        const skillCode = `onet:${rating.elementId}`;
        let skillId = skillIds.get(skillCode);
        if (!skillId) {
          skillId = upsertSkill(skillCode, rating.elementName, category, 'onet').id;
          skillIds.set(skillCode, skillId);
          report.skills += 1;
        }
        // A pair with only one of the two scales published still carries real
        // information; the missing half falls back to the midpoint rather than
        // dropping the requirement entirely.
        const importance = rating.importance ?? 50;
        const level = rating.level ?? importance;
        run(
          `INSERT INTO occupation_skills (occupation_id, skill_id, importance, required_level)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(occupation_id, skill_id) DO UPDATE SET
             importance = excluded.importance, required_level = excluded.required_level`,
          [occupationId(rating.code), skillId, importance, level]
        );
        report.requirements += 1;
      }
    }

    if (includeTechnology) {
      const text = readIfPresent(dir, FILES.technology);
      if (!text) {
        report.skipped.push(FILES.technology);
      } else {
        report.files.push(FILES.technology);
        for (const tech of parseTechnologySkills(text)) {
          if (!keep(tech.code)) continue;
          const slug = tech.commodity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const skillCode = `tech:${slug}`;
          let skillId = skillIds.get(skillCode);
          if (!skillId) {
            skillId = upsertSkill(skillCode, tech.commodity, 'Technology', 'onet', tech.example).id;
            skillIds.set(skillCode, skillId);
            report.skills += 1;
          }
          run(
            `INSERT INTO occupation_skills (occupation_id, skill_id, importance, required_level)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(occupation_id, skill_id) DO NOTHING`,
            [occupationId(tech.code), skillId, tech.hot ? 70 : 50, tech.hot ? 60 : 50]
          );
          report.requirements += 1;
        }
      }
    }
  });

  apply();
  return report;
}
