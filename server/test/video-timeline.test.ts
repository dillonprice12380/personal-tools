import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTimeline, cueAt, partition } from '../src/services/video/timeline.js';
import { normaliseSpec } from '../src/services/video/spec.js';
import { VideoSpecError, type SceneInput, type VideoSpecInput } from '../src/services/video/types.js';

const workDir = mkdtempSync(join(tmpdir(), 'helm-video-test-'));

/** buildTimeline is given narration lengths, so the file only has to exist. */
function narrationFile(name: string): string {
  const path = join(workDir, name);
  writeFileSync(path, '');
  return path;
}

function spec(scenes: SceneInput[], overrides: Partial<VideoSpecInput> = {}) {
  return normaliseSpec({ fps: 30, width: 640, height: 360, scenes, ...overrides }, workDir);
}

test('partition splits frames exactly, with no cue shorter than one frame', () => {
  const cases: [number[], number][] = [
    [[1, 1, 1], 100],
    [[10, 1, 1], 13],
    [[100, 1, 1], 3],
    [[7, 3, 5, 9, 2], 61],
    [[1], 1],
    [[3, 3], 7],
  ];
  for (const [weights, total] of cases) {
    const parts = partition(weights, total);
    assert.equal(parts.length, weights.length);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `weights ${weights} over ${total} frames must sum exactly`);
    for (const part of parts) assert.ok(part >= 1, `every part must be at least one frame, got ${parts}`);
  }
});

test('partition refuses to split fewer frames than there are cues', () => {
  assert.throws(() => partition([1, 1, 1], 2), VideoSpecError);
});

test('scene lengths are whole frames and the total is their sum', () => {
  const file = narrationFile('a.wav');
  const built = spec([
    { id: 'one', narration: file, padStart: 0.2, padEnd: 0.4 },
    { id: 'two', narration: file, padStart: 0, padEnd: 0 },
    { id: 'three', duration: 2.5, title: 'A silent card' },
  ]);
  // Deliberately awkward lengths that do not land on frame boundaries.
  const timeline = buildTimeline(built, [3.417, 5.123, null]);

  for (const scene of timeline.scenes) {
    assert.ok(Number.isInteger(scene.frames), `scene ${scene.id} has a fractional frame count`);
    assert.ok(Number.isInteger(scene.startFrame));
  }
  assert.equal(
    timeline.totalFrames,
    timeline.scenes.reduce((sum, s) => sum + s.frames, 0),
    'the total must be the sum of the scenes, with nothing lost to rounding',
  );
  // 0.2s lead + 3.417s narration + 0.4s tail: the narration is rounded up so a
  // scene can never cut off a word.
  assert.equal(timeline.scenes[0].frames, 6 + Math.ceil(3.417 * 30) + 12);
  assert.equal(timeline.scenes[2].frames, 75);
});

test('scenes are contiguous — no gap and no overlap between them', () => {
  const file = narrationFile('b.wav');
  const built = spec([
    { narration: file }, { narration: file }, { duration: 1.234, title: 'Card' }, { narration: file },
  ]);
  const timeline = buildTimeline(built, [1.05, 2.9, null, 0.4]);
  let expected = 0;
  for (const scene of timeline.scenes) {
    assert.equal(scene.startFrame, expected, `scene ${scene.id} does not start where the previous one ended`);
    assert.equal(scene.endFrame, scene.startFrame + scene.frames);
    expected = scene.endFrame;
  }
  assert.equal(expected, timeline.totalFrames);
});

test('a scene shorter than its own narration is rejected, not silently truncated', () => {
  const file = narrationFile('c.wav');
  const built = spec([{ id: 'too-short', narration: file, duration: 2, padStart: 0.2, padEnd: 0.4 }]);
  assert.throws(
    () => buildTimeline(built, [4.5]),
    (err: unknown) => {
      assert.ok(err instanceof VideoSpecError);
      assert.match((err as Error).message, /too-short/);
      assert.match((err as Error).message, /narration/);
      return true;
    },
  );
});

test('a longer explicit duration is honoured and the extra time goes to the tail', () => {
  const file = narrationFile('d.wav');
  const built = spec([{ narration: file, duration: 10, padStart: 0.2, padEnd: 0.4 }]);
  const timeline = buildTimeline(built, [3]);
  assert.equal(timeline.totalFrames, 300);
  assert.equal(timeline.scenes[0].narrationStartFrame, 6);
  assert.equal(timeline.scenes[0].narrationFrames, 90);
});

test('derived cues cover the narration exactly and never overlap', () => {
  const file = narrationFile('e.wav');
  const built = spec([
    {
      id: 'talk',
      narration: {
        path: file,
        text: 'Helm replaces a stack of monthly subscriptions. It is built for one person. ' +
          'There is no sign-up, no multi-tenancy and no sharing at all, ever.',
      },
      padStart: 0.5,
      padEnd: 0.5,
    },
  ]);
  const timeline = buildTimeline(built, [9.4]);
  const scene = timeline.scenes[0];

  assert.ok(timeline.cues.length > 1, 'the narration should produce several cues');
  assert.equal(timeline.cues[0].startFrame, scene.narrationStartFrame, 'captions start with the narration');
  assert.equal(
    timeline.cues[timeline.cues.length - 1].endFrame,
    scene.narrationStartFrame + scene.narrationFrames,
    'captions end with the narration',
  );

  let previousEnd = scene.narrationStartFrame;
  for (const cue of timeline.cues) {
    assert.equal(cue.startFrame, previousEnd, 'cues must be contiguous');
    assert.ok(cue.endFrame > cue.startFrame, 'a cue must last at least one frame');
    assert.ok(cue.endFrame <= scene.endFrame, 'a cue must not outlive its scene');
    previousEnd = cue.endFrame;
  }
});

test('explicit cues that run past the end of their scene are rejected', () => {
  const built = spec([
    { id: 'fixed', duration: 3, captions: [{ start: 0, end: 1, text: 'fine' }, { start: 2, end: 9, text: 'too long' }] },
  ]);
  assert.throws(() => buildTimeline(built, [null]), /too long|3\.000s/);
});

test('cueAt finds the cue covering a frame, and nothing outside one', () => {
  const file = narrationFile('f.wav');
  const built = spec([
    { narration: { path: file, text: 'One. Two. Three. Four.' }, padStart: 1, padEnd: 1 },
  ]);
  const timeline = buildTimeline(built, [4]);
  for (const cue of timeline.cues) {
    assert.equal(cueAt(timeline.cues, cue.startFrame), cue);
    assert.equal(cueAt(timeline.cues, cue.endFrame - 1), cue);
  }
  assert.equal(cueAt(timeline.cues, 0), null, 'nothing shows during the silent lead-in');
  assert.equal(cueAt(timeline.cues, timeline.totalFrames - 1), null, 'nothing shows during the silent tail');
});
