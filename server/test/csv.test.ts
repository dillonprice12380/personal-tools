import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvObjects, toCents, toIsoDate } from '../src/lib/csv.js';

test('parseCsv handles quotes, escaped quotes and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
  ]);
});

test('parseCsv skips fully blank lines', () => {
  assert.equal(parseCsv('a\n\n\nb\n').length, 2);
});

test('parseCsvObjects normalises headers', () => {
  const rows = parseCsvObjects('Transaction Date,Amount\n2026-01-01,5.00\n');
  assert.deepEqual(rows, [{ transaction_date: '2026-01-01', amount: '5.00' }]);
});

test('toCents reads the formats banks actually export', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents('$1,234.56'), 123456);
  assert.equal(toCents('(12.50)'), -1250, 'parenthesised negatives');
  assert.equal(toCents('-4.5'), -450);
  assert.equal(toCents('1.005'), 101, 'rounds to the nearest cent');
  assert.equal(toCents('1234,56'), 123456, 'comma decimal separator');
  assert.equal(toCents(''), null);
  assert.equal(toCents('n/a'), null);
});

test('toIsoDate normalises common date formats', () => {
  assert.equal(toIsoDate('2026-01-05'), '2026-01-05');
  assert.equal(toIsoDate('01/05/2026'), '2026-01-05', 'US ordering by default');
  assert.equal(toIsoDate('25/12/2026'), '2026-12-25', 'falls back to DD/MM when unambiguous');
  assert.equal(toIsoDate('1/5/26'), '2026-01-05');
  assert.equal(toIsoDate('nonsense'), null);
});
