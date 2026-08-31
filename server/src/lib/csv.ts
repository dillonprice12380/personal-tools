/**
 * Minimal RFC-4180 CSV reader - enough for bank and card exports, without
 * pulling in a dependency. Handles quoted fields, escaped quotes and CRLF.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Swallow the LF of a CRLF pair.
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

/** Parse CSV with a header row into objects keyed by normalised header name. */
export function parseCsvObjects(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((header, i) => [header, (cells[i] ?? '').trim()]))
  );
}

/** "$1,234.56" / "(12.30)" / "-4.5" -> signed integer cents. */
export function toCents(raw: string): number | null {
  if (raw === undefined || raw === null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^0-9.,-]/g, '');
  // Treat a comma as the decimal separator only when no dot is present.
  if (text.includes(',') && !text.includes('.')) text = text.replace(',', '.');
  text = text.replace(/,/g, '');
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  // Without a digit there is no amount here - return null so the importer
  // reports the row instead of silently booking it as 0.00.
  if (!/\d/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // Nudge by an epsilon before rounding: 1.005 is stored as 1.00499999...,
  // which would otherwise silently drop a cent.
  return Math.round((value + Number.EPSILON) * 100) * (negative ? -1 : 1);
}

/** Normalise common bank date formats to YYYY-MM-DD. */
export function toIsoDate(raw: string): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const [, a, b, c] = slash;
    const year = c.length === 2 ? `20${c}` : c;
    // Ambiguous DD/MM vs MM/DD: assume US ordering unless the first part
    // cannot be a month.
    const month = Number(a) > 12 ? b : a;
    const day = Number(a) > 12 ? a : b;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}
