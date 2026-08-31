/** Cents -> "$1,234.56". Amounts are always integers of cents server-side. */
export function money(cents: number | null | undefined, currency = 'USD'): string {
  const value = (cents ?? 0) / 100;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);
}

/** Compact form for stat tiles: $12.4k. */
export function moneyShort(cents: number | null | undefined, currency = 'USD'): string {
  const value = (cents ?? 0) / 100;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 10_000 ? 1 : 0,
  }).format(value);
}

export function num(value: number | null | undefined, digits = 0): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value ?? 0);
}

export function percent(value: number | null | undefined, digits = 0): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value ?? 0)}%`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function shiftMonth(key: string, months: number): string {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : DATE_FMT.format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : DATETIME_FMT.format(date);
}

export function formatMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(
    new Date(Date.UTC(y, m - 1, 1))
  );
}

/** "in 3 days" / "2 days ago" for due dates. */
export function relativeDay(value: string | null | undefined): string {
  if (!value) return '';
  const target = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return '';
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target.getTime() - start.getTime()) / 864e5);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days}d` : `${Math.abs(days)}d ago`;
}

export function minutesToHours(minutes: number | null | undefined): string {
  const total = minutes ?? 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m}m`;
}

/** Dollars typed by a human -> integer cents. */
export function dollarsToCents(input: string | number): number {
  const value = typeof input === 'number' ? input : Number(String(input).replace(/[^0-9.-]/g, ''));
  // The epsilon keeps 1.005 from rounding down to 100 cents.
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) : 0;
}

export function centsToDollars(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}
