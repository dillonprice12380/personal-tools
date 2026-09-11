import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseImportance,
  normaliseLevel,
  parseDelimited,
  parseElementRatings,
  parseOccupationData,
  parseTechnologySkills,
} from '../src/services/skills/onet.js';

const tsv = (rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');

test('O*NET scales normalise onto 0-100', () => {
  // Importance is published 1-5, level 0-7.
  assert.equal(normaliseImportance(1), 0);
  assert.equal(normaliseImportance(5), 100);
  assert.equal(normaliseImportance(3), 50);
  assert.equal(normaliseLevel(0), 0);
  assert.equal(normaliseLevel(7), 100);
});

test('the delimited reader survives CRLF, a BOM and short rows', () => {
  const text = '﻿A\tB\tC\r\n1\t2\t3\r\n4\t5\r\n';
  const table = parseDelimited(text);
  assert.deepEqual(table.headers, ['A', 'B', 'C']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1].C, '', 'a missing trailing cell reads as empty, not undefined');
});

test('occupation data is read by header name, not column position', () => {
  const text = tsv([
    ['Description', 'O*NET-SOC Code', 'Title'],
    ['Builds web things.', '15-1254.00', 'Web Developers'],
  ]);
  assert.deepEqual(parseOccupationData(text), [
    { code: '15-1254.00', title: 'Web Developers', description: 'Builds web things.' },
  ]);
});

test('importance and level rows for one element fold into a single requirement', () => {
  const text = tsv([
    ['O*NET-SOC Code', 'Element ID', 'Element Name', 'Scale ID', 'Data Value', 'Recommend Suppress', 'Not Relevant'],
    ['15-1254.00', '2.A.1.a', 'Reading Comprehension', 'IM', '4.12', 'n', 'n'],
    ['15-1254.00', '2.A.1.a', 'Reading Comprehension', 'LV', '4.50', 'n', 'n'],
  ]);
  const ratings = parseElementRatings(text);
  assert.equal(ratings.length, 1);
  assert.equal(ratings[0].elementName, 'Reading Comprehension');
  assert.equal(ratings[0].importance, normaliseImportance(4.12));
  assert.equal(ratings[0].level, normaliseLevel(4.5));
});

test('suppressed and not-relevant ratings are dropped rather than imported', () => {
  // O*NET flags these when the estimate is too thin to publish; carrying them
  // through would put invented precision into a gap report.
  const text = tsv([
    ['O*NET-SOC Code', 'Element ID', 'Element Name', 'Scale ID', 'Data Value', 'Recommend Suppress', 'Not Relevant'],
    ['15-1254.00', '2.A.1.a', 'Reading Comprehension', 'IM', '4.12', 'Y', 'n'],
    ['15-1254.00', '2.B.1.a', 'Active Learning', 'IM', '3.00', 'n', 'Y'],
    ['15-1254.00', '2.B.3.a', 'Programming', 'IM', '4.50', 'n', 'n'],
  ]);
  const ratings = parseElementRatings(text);
  assert.deepEqual(ratings.map((r) => r.elementName), ['Programming']);
});

test('an element published on only one scale still yields a requirement', () => {
  const text = tsv([
    ['O*NET-SOC Code', 'Element ID', 'Element Name', 'Scale ID', 'Data Value'],
    ['15-1254.00', '2.A.1.a', 'Reading Comprehension', 'IM', '5'],
  ]);
  const [rating] = parseElementRatings(text);
  assert.equal(rating.importance, 100);
  assert.equal(rating.level, null, 'the missing scale is null here; the importer fills it in');
});

test('technology skills parse, carrying the hot-technology flag', () => {
  const text = tsv([
    ['O*NET-SOC Code', 'Example', 'Commodity Code', 'Commodity Title', 'Hot Technology', 'In Demand'],
    ['15-1254.00', 'React', '43232405', 'Web platform development software', 'Y', 'Y'],
    ['15-1254.00', 'Apache Ant', '43232405', 'Development environment software', 'N', 'N'],
  ]);
  const rows = parseTechnologySkills(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].commodity, 'Web platform development software');
  assert.equal(rows[0].hot, true);
  assert.equal(rows[1].hot, false);
});

test('a file whose required columns are missing yields nothing instead of garbage', () => {
  assert.deepEqual(parseOccupationData(tsv([['Something', 'Else'], ['a', 'b']])), []);
  assert.deepEqual(parseElementRatings(tsv([['Nope'], ['x']])), []);
  assert.deepEqual(parseDelimited('').rows, []);
});
