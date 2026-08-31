import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, nextAfter, shiftDays, monthRange, addMonthsToKey } from '../src/services/recurrence.js';

test('advance steps each cadence', () => {
  assert.equal(advance('2026-01-15', 'daily'), '2026-01-16');
  assert.equal(advance('2026-01-15', 'weekly'), '2026-01-22');
  assert.equal(advance('2026-01-15', 'biweekly'), '2026-01-29');
  assert.equal(advance('2026-01-15', 'monthly'), '2026-02-15');
  assert.equal(advance('2026-01-15', 'quarterly'), '2026-04-15');
  assert.equal(advance('2026-01-15', 'yearly'), '2027-01-15');
});

test('monthly steps clamp to the end of a shorter month', () => {
  // The 31st recurring monthly must not roll into the following month.
  assert.equal(advance('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(advance('2024-01-31', 'monthly'), '2024-02-29', 'leap year');
  assert.equal(advance('2026-03-31', 'monthly'), '2026-04-30');
  assert.equal(advance('2026-08-31', 'quarterly'), '2026-11-30');
});

test('yearly handles Feb 29', () => {
  assert.equal(advance('2024-02-29', 'yearly'), '2025-02-28');
});

test('shiftDays crosses month and year boundaries', () => {
  assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDays('2026-03-01', -1), '2026-02-28');
});

test('nextAfter skips missed occurrences instead of backfilling', () => {
  // A weekly item last due months ago yields ONE next date in the future.
  const next = nextAfter('2026-01-01', 'weekly', '2026-03-10');
  assert.ok(next > '2026-03-10');
  assert.ok(next <= '2026-03-17', `expected the first future occurrence, got ${next}`);
});

test('monthRange covers the whole month', () => {
  assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
});

test('addMonthsToKey wraps years', () => {
  assert.equal(addMonthsToKey('2026-12', 1), '2027-01');
  assert.equal(addMonthsToKey('2026-01', -1), '2025-12');
});
