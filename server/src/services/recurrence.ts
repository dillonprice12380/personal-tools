/**
 * Date maths for recurring tasks and recurring transactions.
 * All dates are 'YYYY-MM-DD' strings handled in UTC so a server timezone
 * change can never shift a due date by a day.
 */
export type Cadence =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

export const CADENCES: Cadence[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
];

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseDate(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Advance a date by one cadence step. Month-based steps clamp to the end of
 * the target month, so the 31st recurring monthly lands on the 28th/30th
 * rather than rolling into the next month.
 */
export function advance(date: string, cadence: Cadence, steps = 1): string {
  const { y, m, d } = parseDate(date);
  switch (cadence) {
    case 'daily':
      return shiftDays(date, steps);
    case 'weekly':
      return shiftDays(date, 7 * steps);
    case 'biweekly':
      return shiftDays(date, 14 * steps);
    case 'monthly':
      return shiftMonths(y, m, d, steps);
    case 'quarterly':
      return shiftMonths(y, m, d, 3 * steps);
    case 'yearly':
      return shiftMonths(y, m, d, 12 * steps);
    default:
      return date;
  }
}

export function shiftDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  const t = Date.UTC(y, m - 1, d) + days * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

function shiftMonths(y: number, m: number, d: number, months: number): string {
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/**
 * Roll a due date forward until it is strictly in the future, so a recurring
 * item that was missed for weeks produces one next occurrence rather than a
 * backlog of them.
 */
export function nextAfter(date: string, cadence: Cadence, from = today()): string {
  let next = advance(date, cadence);
  let guard = 0;
  while (next <= from && guard++ < 500) next = advance(next, cadence);
  return next;
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function addMonthsToKey(key: string, months: number): string {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthRange(key: string): { start: string; end: string } {
  const [y, m] = key.split('-').map(Number);
  return { start: `${key}-01`, end: fmt(y, m, daysInMonth(y, m)) };
}
