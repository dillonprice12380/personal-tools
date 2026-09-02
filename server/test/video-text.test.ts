import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkForCaptions, fitText, TextOverflowError, wrap } from '../src/services/video/text.js';

/** Every character is half the font size wide — exact and easy to reason about. */
const measure = (text: string, size: number) => text.length * size * 0.5;

test('wrap breaks greedily at the box edge', () => {
  // 10px per character at size 20; a 100px box holds 10 characters.
  assert.deepEqual(wrap('aaa bbb ccc ddd', 20, 100, measure), ['aaa bbb', 'ccc ddd']);
});

test('wrap keeps every word, in order, when a word is wider than the box', () => {
  const text = 'short Pneumonoultramicroscopicsilicovolcanoconiosis tail';
  const lines = wrap(text, 20, 100, measure);
  for (const line of lines) {
    assert.ok(measure(line, 20) <= 100, `line "${line}" is ${measure(line, 20)}px, over the 100px box`);
  }
  // Re-joining must reproduce the input: nothing dropped, nothing reordered.
  assert.equal(lines.join('').replace(/ /g, ''), text.replace(/ /g, ''));
  assert.ok(lines[0].startsWith('short'), 'the first line still starts with the first word');
  assert.ok(lines[lines.length - 1].endsWith('tail'), 'the last line still ends with the last word');
});

test('wrap on an empty or blank string produces no lines', () => {
  assert.deepEqual(wrap('', 20, 100, measure), []);
  assert.deepEqual(wrap('   \n\t ', 20, 100, measure), []);
});

test('fitText returns the largest size that fits and never overflows', () => {
  const result = fitText({
    text: 'one two three four five six',
    fontSize: 40,
    minFontSize: 8,
    maxWidth: 200,
    maxHeight: 200,
    maxLines: 3,
    lineHeightFactor: 1.2,
    measure,
    label: 'test',
  });
  assert.ok(result.lines.length <= 3);
  assert.ok(result.width <= 200);
  assert.ok(result.height <= 200);
  assert.ok(result.fontSize <= 40 && result.fontSize >= 8);
  for (const line of result.lines) assert.ok(measure(line, result.fontSize) <= 200);
});

test('fitText shrinks rather than spilling out of a tight box', () => {
  const roomy = fitText({
    text: 'the quick brown fox', fontSize: 40, minFontSize: 6, maxWidth: 400, maxHeight: 400,
    maxLines: 4, lineHeightFactor: 1.2, measure, label: 'roomy',
  });
  const tight = fitText({
    text: 'the quick brown fox', fontSize: 40, minFontSize: 6, maxWidth: 100, maxHeight: 60,
    maxLines: 2, lineHeightFactor: 1.2, measure, label: 'tight',
  });
  assert.ok(tight.fontSize < roomy.fontSize, 'the tight box got a smaller size');
  assert.ok(tight.lines.length <= 2);
  assert.ok(tight.height <= 60);
});

test('fitText throws instead of clipping text that cannot be made to fit', () => {
  assert.throws(
    () =>
      fitText({
        text: 'far too many words to ever fit inside a single very small line of text',
        fontSize: 40, minFontSize: 30, maxWidth: 60, maxHeight: 40,
        maxLines: 1, lineHeightFactor: 1.2, measure, label: 'scenes[2] title',
      }),
    (err: unknown) => {
      assert.ok(err instanceof TextOverflowError);
      assert.match((err as Error).message, /scenes\[2\] title/);
      assert.match((err as Error).message, /does not fit/);
      return true;
    },
  );
});

test('chunkForCaptions keeps every chunk inside the line budget', () => {
  const text =
    'Helm replaces a stack of monthly subscriptions. It is built for one person; there is no sign-up, ' +
    'no multi-tenancy and no sharing. The first account you create is the only account it will ever have.';
  const chunks = chunkForCaptions(text, 42, 2);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 84, `chunk of ${chunk.length} chars exceeds the 84 character budget: ${chunk}`);
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '), 'no words lost');
});

test('chunkForCaptions splits a single over-long sentence with no punctuation', () => {
  const text = 'a '.repeat(80).trim();
  const chunks = chunkForCaptions(text, 20, 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 40);
  assert.equal(chunks.join(' '), text);
});
