import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpportunity } from '../src/services/seo/gsc.js';

test('page-two queries with real demand are the top priority', () => {
  const o = classifyOpportunity({ query: 'k', clicks: 2, impressions: 800, ctr: 0.0025, position: 13.4 });
  assert.equal(o?.kind, 'striking_distance');
  assert.match(o!.reason, /page two/);
});

test('page-two queries nobody searches are ignored', () => {
  assert.equal(
    classifyOpportunity({ query: 'k', clicks: 0, impressions: 4, ctr: 0, position: 14 }),
    null
  );
});

test('mid page-one queries are flagged for a push to the top three', () => {
  const o = classifyOpportunity({ query: 'k', clicks: 20, impressions: 900, ctr: 0.022, position: 6.2 });
  assert.equal(o?.kind, 'push_to_top3');
});

test('good ranking with poor click-through is a snippet problem', () => {
  // Position ~2 usually earns around 15%; 3% is far below that.
  const o = classifyOpportunity({ query: 'k', clicks: 15, impressions: 500, ctr: 0.03, position: 2.1 });
  assert.equal(o?.kind, 'low_ctr');
  assert.match(o!.reason, /title and description/);
});

test('a healthy top-three query is not an opportunity', () => {
  assert.equal(
    classifyOpportunity({ query: 'k', clicks: 300, impressions: 1000, ctr: 0.3, position: 1.2 }),
    null
  );
});

test('priority ranks bigger opportunities first', () => {
  const big = classifyOpportunity({ query: 'a', clicks: 1, impressions: 5000, ctr: 0.0002, position: 12 });
  const small = classifyOpportunity({ query: 'b', clicks: 1, impressions: 60, ctr: 0.016, position: 12 });
  assert.ok(big!.priority > small!.priority);
});

test('deep results are left alone - they need content, not tweaks', () => {
  assert.equal(
    classifyOpportunity({ query: 'k', clicks: 0, impressions: 900, ctr: 0, position: 47 }),
    null
  );
});
