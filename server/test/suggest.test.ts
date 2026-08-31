import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestUrl, parseSuggestResponse } from '../src/services/seo/suggest.js';

test('parses the autocomplete response shape', () => {
  // The endpoint answers [term, [suggestions], ...].
  const body = JSON.stringify([
    'espresso machine',
    ['espresso machine for home', 'espresso machine with grinder', 'espresso machine cheap'],
  ]);
  assert.deepEqual(parseSuggestResponse(body), [
    'espresso machine for home',
    'espresso machine with grinder',
    'espresso machine cheap',
  ]);
});

test('tolerates the trailing metadata arrays Google sometimes appends', () => {
  const body = JSON.stringify(['seed', ['one', 'two'], [], { 'google:suggestsubtypes': [[512]] }]);
  assert.deepEqual(parseSuggestResponse(body), ['one', 'two']);
});

test('drops non-string and empty entries rather than surfacing junk', () => {
  const body = JSON.stringify(['seed', ['real', '', 42, null, 'also real']]);
  assert.deepEqual(parseSuggestResponse(body), ['real', 'also real']);
});

test('returns nothing for malformed or unexpected bodies', () => {
  assert.deepEqual(parseSuggestResponse('not json at all'), []);
  assert.deepEqual(parseSuggestResponse('{}'), []);
  assert.deepEqual(parseSuggestResponse(JSON.stringify(['seed'])), []);
  assert.deepEqual(parseSuggestResponse(''), []);
});

test('builds a request URL with the parameters the endpoint expects', () => {
  const url = new URL(buildSuggestUrl('coffee beans', 'gb'));
  assert.equal(url.hostname, 'suggestqueries.google.com');
  assert.equal(url.searchParams.get('client'), 'firefox');
  assert.equal(url.searchParams.get('q'), 'coffee beans');
  assert.equal(url.searchParams.get('gl'), 'gb');
});
