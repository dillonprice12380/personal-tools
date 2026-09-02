import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normaliseSpec, parseSrt, PRESETS } from '../src/services/video/spec.js';
import { toSrt, toVtt } from '../src/services/video/captions.js';
import { VideoSpecError, type VideoSpecInput } from '../src/services/video/types.js';

const workDir = mkdtempSync(join(tmpdir(), 'helm-video-spec-'));
const audioFile = join(workDir, 'narration.wav');
writeFileSync(audioFile, '');

const minimal: VideoSpecInput = { scenes: [{ title: 'Hello', duration: 2 }] };

function problemsFrom(input: VideoSpecInput): string {
  try {
    normaliseSpec(input, workDir);
  } catch (err) {
    assert.ok(err instanceof VideoSpecError, `expected a VideoSpecError, got ${String(err)}`);
    return (err as Error).message;
  }
  throw new assert.AssertionError({ message: 'expected the spec to be rejected, but it was accepted' });
}

test('defaults fill in a full spec from a minimal one', () => {
  const spec = normaliseSpec(minimal, workDir);
  assert.equal(spec.width, PRESETS.youtube.width);
  assert.equal(spec.height, PRESETS.youtube.height);
  assert.equal(spec.fps, 30);
  assert.equal(spec.audio.sampleRate, 48000);
  assert.equal(spec.captions.enabled, true);
  assert.equal(spec.scenes[0].id, 'scene-1');
  assert.ok(spec.theme.fontFile.length > 0, 'a font file was resolved');
  assert.ok(spec.output.endsWith('video.mp4'));
});

test('a preset sets the frame size and an explicit size overrides it', () => {
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(normaliseSpec({ ...minimal, preset: 'vertical' }, workDir)),
    { width: 1080, height: 1920 },
  );
  const overridden = normaliseSpec({ ...minimal, preset: 'vertical', width: 720, height: 1280 }, workDir);
  assert.equal(overridden.width, 720);
  assert.equal(overridden.height, 1280);
});

test('odd frame dimensions are rejected before anything is encoded', () => {
  const message = problemsFrom({ ...minimal, width: 1921, height: 1081 });
  assert.match(message, /width: must be even/);
  assert.match(message, /height: must be even/);
});

test('a frame rate that would drift against the audio clock is rejected', () => {
  const message = problemsFrom({ ...minimal, fps: 7 });
  assert.match(message, /does not divide the 48000 Hz audio into whole samples/);
  // The frame rates that do divide it are accepted.
  for (const fps of [24, 25, 30, 50, 60]) {
    assert.equal(normaliseSpec({ ...minimal, fps }, workDir).fps, fps);
  }
});

test('every problem is reported at once, with the field that caused it', () => {
  const message = problemsFrom({
    width: 1921,
    fps: 7,
    theme: { titleColor: 'red', safeArea: 0.9 },
    scenes: [
      { title: 'ok', duration: 2 },
      { id: 'no-length', title: 'missing a duration' },
      { narration: 'nowhere.wav', title: 'bad path' },
    ],
  });
  assert.match(message, /width: must be even/);
  assert.match(message, /theme\.titleColor: must be a hex colour/);
  assert.match(message, /theme\.safeArea: must be at most 0\.4/);
  assert.match(message, /scenes\[1\]: needs either a narration file or an explicit duration/);
  assert.match(message, /scenes\[2\]\.narration\.path: file not found/);
  assert.match(message, /has 6 problem\(s\)/);
});

test('duplicate scene ids are reported', () => {
  const message = problemsFrom({
    scenes: [{ id: 'same', duration: 1 }, { id: 'same', duration: 1 }],
  });
  assert.match(message, /duplicate scene id "same"/);
});

test('overlapping caption cues are rejected', () => {
  const message = problemsFrom({
    scenes: [{ duration: 5, captions: [{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }] }],
  });
  assert.match(message, /must not overlap/);
});

test('relative paths resolve against the spec file, not the process directory', () => {
  const spec = normaliseSpec({ output: 'out/clip.mp4', scenes: [{ narration: 'narration.wav', title: 'x' }] }, workDir);
  assert.equal(spec.scenes[0].narration?.path, audioFile);
  assert.equal(spec.output, join(workDir, 'out', 'clip.mp4'));
});

test('srt round-trips through parse and serialise', () => {
  const cues = [
    { startFrame: 6, endFrame: 83, text: 'First line of narration.', sceneIndex: 0 },
    { startFrame: 83, endFrame: 190, text: 'Second line, a little longer.', sceneIndex: 0 },
  ];
  const srt = toSrt(cues, 30);
  assert.match(srt, /00:00:00,200 --> 00:00:02,767/);
  assert.match(toVtt(cues, 30), /^WEBVTT/);
  assert.match(toVtt(cues, 30), /00:00:00\.200 --> 00:00:02\.767/);

  const parsed = parseSrt(srt);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'First line of narration.');
  // Frames -> timestamp -> seconds must land back on the same frame.
  assert.equal(Math.round(parsed[0].start * 30), 6);
  assert.equal(Math.round(parsed[1].end * 30), 190);
});

test('a malformed srt is reported rather than silently dropped', () => {
  assert.throws(() => parseSrt('1\nthis is not a timing line\nsome text\n'), /no timing line/);
});

/* ------------------------------------------------------------------ */
/* Path confinement — the boundary that makes a spec safe over HTTP    */
/* ------------------------------------------------------------------ */

test('allowedRoot permits a file inside the root', () => {
  const inside = join(workDir, 'inside.wav');
  writeFileSync(inside, '');
  const spec = normaliseSpec(
    { scenes: [{ narration: 'inside.wav', title: 'ok' }] },
    workDir,
    { allowedRoot: workDir },
  );
  assert.equal(spec.scenes[0].narration?.path, inside);
});

test('allowedRoot refuses a relative path that climbs out of the root', () => {
  const nested = join(workDir, 'nested');
  mkdirSync(nested, { recursive: true });
  const message = (() => {
    try {
      normaliseSpec(
        { scenes: [{ narration: '../narration.wav', title: 'x' }] },
        nested,
        { allowedRoot: nested },
      );
    } catch (err) {
      return (err as Error).message;
    }
    throw new assert.AssertionError({ message: 'the escaping path was accepted' });
  })();
  assert.match(message, /must be inside/);
});

test('allowedRoot refuses an absolute path outside the root', () => {
  for (const attack of ['/etc/passwd', '/etc/hostname']) {
    const message = (() => {
      try {
        normaliseSpec(
          { scenes: [{ duration: 2, title: 'x', background: { type: 'image', path: attack } }] },
          workDir,
          { allowedRoot: workDir },
        );
      } catch (err) {
        return (err as Error).message;
      }
      throw new assert.AssertionError({ message: `${attack} was accepted` });
    })();
    assert.match(message, /must be inside/);
  }
});

test('allowedRoot refuses a symlink inside the root that points outside it', () => {
  const target = join(workDir, '..', `escape-${Date.now()}.wav`);
  writeFileSync(target, '');
  const link = join(workDir, 'looks-innocent.wav');
  try {
    symlinkSync(target, link);
  } catch {
    return; // Some filesystems disallow symlinks; the other cases still cover it.
  }
  const message = (() => {
    try {
      normaliseSpec({ scenes: [{ narration: 'looks-innocent.wav', title: 'x' }] }, workDir, {
        allowedRoot: workDir,
      });
    } catch (err) {
      return (err as Error).message;
    }
    throw new assert.AssertionError({ message: 'the symlink out of the root was accepted' });
  })();
  assert.match(message, /must be inside/);
});

test('a confined spec may not choose its own font file', () => {
  const message = (() => {
    try {
      normaliseSpec(
        { theme: { fontFile: '/etc/passwd' }, scenes: [{ duration: 2, title: 'x' }] },
        workDir,
        { allowedRoot: workDir },
      );
    } catch (err) {
      return (err as Error).message;
    }
    throw new assert.AssertionError({ message: 'the font override was accepted' });
  })();
  assert.match(message, /theme\.fontFile: cannot be set/);
});

test('forceOutput wins over the output named in the spec', () => {
  const forced = join(workDir, 'forced.mp4');
  const spec = normaliseSpec(
    { output: '/tmp/somewhere-else.mp4', scenes: [{ duration: 1, title: 'x' }] },
    workDir,
    { allowedRoot: workDir, forceOutput: forced },
  );
  assert.equal(spec.output, forced);
});

test('without allowedRoot the CLI keeps its run-it-yourself freedom', () => {
  const outside = join(workDir, '..', `cli-${Date.now()}.wav`);
  writeFileSync(outside, '');
  const spec = normaliseSpec({ scenes: [{ narration: outside, title: 'x' }] }, workDir);
  assert.equal(spec.scenes[0].narration?.path, outside);
});
