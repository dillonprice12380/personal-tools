import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/services/seo/analyze.js';

const ORIGIN = 'https://example.com';

const wellOptimised = `<!doctype html><html><head>
<title>How to brew espresso at home: a complete guide</title>
<meta name="description" content="A step-by-step espresso guide covering grind size, dose and extraction time.">
<link rel="canonical" href="https://example.com/guide">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Article","author":{"@type":"Person","name":"Ada"},"dateModified":"${new Date().toISOString().slice(0, 10)}"},
 {"@type":"FAQPage"}]}
</script></head><body>
<h1>How to brew espresso at home</h1>
<p>Brewing espresso at home takes an 18 gram dose, a 25 second extraction and a burr grinder set fine.</p>
<h2>What is espresso?</h2><p>${'Detail. '.repeat(80)}</p>
<h2>How do you dial in a shot?</h2><ol><li>Weigh</li><li>Grind</li><li>Time it</li></ol>
<a href="/shop">Shop</a><a href="https://other.example">Out</a>
<img src="a.png" alt="shot"></body></html>`;

const poor = `<!doctype html><html><head></head><body>
<p>Call us.</p><img src="a.png"><img src="b.png"></body></html>`;

test('extracts on-page facts', () => {
  const facts = analyze(wellOptimised, `${ORIGIN}/guide`, ORIGIN);
  assert.equal(facts.title, 'How to brew espresso at home: a complete guide');
  assert.equal(facts.h1, 'How to brew espresso at home');
  assert.equal(facts.h1_count, 1);
  assert.equal(facts.h2_count, 2);
  assert.equal(facts.canonical, 'https://example.com/guide');
  assert.equal(facts.internal_links, 1);
  assert.equal(facts.external_links, 1);
  assert.equal(facts.images, 1);
  assert.equal(facts.images_no_alt, 0);
  assert.ok(facts.word_count > 80);
  assert.ok(facts.schema_types.includes('Article'), 'reads @graph schema types');
  assert.ok(facts.schema_types.includes('FAQPage'));
  assert.deepEqual(facts.links, ['https://example.com/shop'], 'only same-origin links are queued');
});

test('scores a well-marked-up page highly for answer engines', () => {
  const facts = analyze(wellOptimised, `${ORIGIN}/guide`, ORIGIN);
  assert.ok(facts.aeo_score >= 80, `expected a high AEO score, got ${facts.aeo_score}`);
  const failed = facts.aeo_checks.filter((c) => !c.passed).map((c) => c.id);
  assert.deepEqual(failed, [], `unexpected failing checks: ${failed.join(', ')}`);
});

test('flags the problems on a poor page', () => {
  const facts = analyze(poor, `${ORIGIN}/thin`, ORIGIN);
  const codes = facts.issues.map((i) => i.code);
  for (const expected of [
    'title_missing',
    'h1_missing',
    'thin_content',
    'meta_description_missing',
    'images_no_alt',
    'no_structured_data',
    'no_internal_links',
  ]) {
    assert.ok(codes.includes(expected), `expected issue ${expected}, got ${codes.join(', ')}`);
  }
  assert.equal(facts.images_no_alt, 2);
  assert.ok(facts.aeo_score < 40);
});

test('detects noindex as critical', () => {
  const html = '<html><head><title>x</title><meta name="robots" content="noindex, follow"></head><body><h1>x</h1></body></html>';
  const facts = analyze(html, ORIGIN, ORIGIN);
  const noindex = facts.issues.find((i) => i.code === 'noindex');
  assert.ok(noindex);
  assert.equal(noindex!.severity, 'critical');
});

test('title length rules fire at the right boundaries', () => {
  const long = analyze(
    `<html><head><title>${'a'.repeat(75)}</title></head><body><h1>t</h1></body></html>`,
    ORIGIN,
    ORIGIN
  );
  assert.ok(long.issues.some((i) => i.code === 'title_long'));
  const short = analyze('<html><head><title>Hi</title></head><body><h1>t</h1></body></html>', ORIGIN, ORIGIN);
  assert.ok(short.issues.some((i) => i.code === 'title_short'));
});

test('malformed JSON-LD does not throw', () => {
  const html = '<html><head><title>t</title><script type="application/ld+json">{not json</script></head><body><h1>t</h1></body></html>';
  assert.doesNotThrow(() => analyze(html, ORIGIN, ORIGIN));
});
