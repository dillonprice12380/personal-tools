/**
 * End-to-end render. This is the test that matters: it encodes a real file and
 * then measures the file, rather than trusting the renderer's own report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probe, run, countAudioSamples } from '../src/services/video/ffmpeg.js';
import { normaliseSpec } from '../src/services/video/spec.js';
import { renderVideo } from '../src/services/video/render.js';
import { parseSrt } from '../src/services/video/spec.js';
import type { VideoSpecInput } from '../src/services/video/types.js';

const workDir = mkdtempSync(join(tmpdir(), 'helm-video-e2e-'));

/** A tone of an awkward length, to make the frame rounding do real work. */
async function tone(name: string, seconds: number, hz: number): Promise<string> {
  const path = join(workDir, name);
  await run(
    ffmpeg().path,
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${seconds}`,
     '-af', 'volume=-6dB', '-ac', '1', '-ar', '44100', path],
    'making a test tone',
  );
  return path;
}

test('renders a file whose frame count, rate and audio length match the spec', async (t) => {
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const first = await tone('a.wav', 1.317, 220);
  const second = await tone('b.wav', 0.849, 330);

  const input: VideoSpecInput = {
    output: join(workDir, 'out.mp4'),
    width: 320,
    height: 180,
    fps: 24,
    fade: 0.1,
    theme: { safeArea: 0.05, titleSize: 22, bodySize: 13, captionSize: 12, minFontSize: 8 },
    scenes: [
      {
        id: 'one',
        narration: { path: first, text: 'A first line of narration. And a second sentence after it.' },
        padStart: 0.2,
        padEnd: 0.3,
        title: 'First',
      },
      {
        id: 'two',
        narration: { path: second, text: 'A closing thought.' },
        padStart: 0,
        padEnd: 0.5,
        title: 'Second',
        bullets: ['One', 'Two'],
      },
      { id: 'three', duration: 0.5, title: 'Silent card' },
    ],
  };

  const spec = normaliseSpec(input, workDir);
  const result = await renderVideo(spec, { fullVerify: true, preset: 'ultrafast', crf: 30 });

  // The timeline the renderer planned, computed independently here.
  const expectedFrames =
    Math.round(0.2 * 24) + Math.ceil(1.317 * 24) + Math.round(0.3 * 24) +
    Math.ceil(0.849 * 24) + Math.round(0.5 * 24) +
    Math.round(0.5 * 24);
  assert.equal(result.timeline.totalFrames, expectedFrames);

  assert.ok(existsSync(spec.output));
  const probed = await probe(spec.output, true);
  const video = probed.streams.find((s) => s.codec_type === 'video');
  const audio = probed.streams.find((s) => s.codec_type === 'audio');
  assert.ok(video && audio);

  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.avg_frame_rate, '24/1', 'the output must be constant frame rate');
  assert.equal(Number(video.nb_read_frames), expectedFrames, 'decoded frame count must match the timeline');

  // The audio must be the same length as the picture, to within the encoder's
  // final padded packet.
  const videoSeconds = expectedFrames / 24;
  assert.ok(
    Math.abs(Number(audio.duration) - videoSeconds) <= 2 / 24,
    `audio is ${audio.duration}s but the picture is ${videoSeconds}s`,
  );

  // Captions were written, and their times land back on the frames they came from.
  assert.ok(result.srtPath && existsSync(result.srtPath));
  const cues = parseSrt(readFileSync(result.srtPath as string, 'utf8'));
  assert.equal(cues.length, result.timeline.cues.length);
  cues.forEach((cue, i) => {
    assert.equal(Math.round(cue.start * 24), result.timeline.cues[i].startFrame);
    assert.equal(Math.round(cue.end * 24), result.timeline.cues[i].endFrame);
  });

  // No cue may point at a frame the video does not contain.
  for (const cue of result.timeline.cues) {
    assert.ok(cue.endFrame <= expectedFrames, 'a caption outlives the video');
  }
});

test('the assembled audio track is sample-exact against the frame count', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-video-audio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { buildAudioTrack } = await import('../src/services/video/audio.js');
  const { buildTimeline } = await import('../src/services/video/timeline.js');

  const path = join(dir, 'n.wav');
  await run(
    ffmpeg().path,
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=2.077',
     '-ac', '1', '-ar', '32000', path],
    'making a test tone',
  );

  const spec = normaliseSpec(
    { width: 320, height: 180, fps: 25, scenes: [{ narration: path, title: 'x', padStart: 0.13, padEnd: 0.21 }] },
    dir,
  );
  const timeline = buildTimeline(spec, [2.077]);
  const track = await buildAudioTrack(spec, timeline, join(dir, 'work'));

  const samplesPerFrame = spec.audio.sampleRate / spec.fps;
  assert.equal(track.samples, timeline.totalFrames * samplesPerFrame);
  assert.equal(await countAudioSamples(track.path, spec.audio.sampleRate), track.samples);
});

test('verification rejects a file that does not match the timeline', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-video-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { verifyOutput } = await import('../src/services/video/verify.js');
  const { VideoVerificationError } = await import('../src/services/video/types.js');

  const path = join(dir, 'n.wav');
  await run(
    ffmpeg().path,
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
     '-ac', '1', path],
    'making a test tone',
  );
  const spec = normaliseSpec(
    { output: join(dir, 'out.mp4'), width: 320, height: 180, fps: 24, scenes: [{ narration: path, title: 'x' }] },
    dir,
  );
  const result = await renderVideo(spec, { fullVerify: true, preset: 'ultrafast', crf: 35 });

  // The real file, checked against a timeline claiming ten more frames.
  const wrong = { ...result.timeline, totalFrames: result.timeline.totalFrames + 10 };
  await assert.rejects(
    () => verifyOutput(spec.output, spec, wrong, { countFrames: true, expectsSound: true }),
    (err: unknown) => {
      assert.ok(err instanceof VideoVerificationError);
      assert.match((err as Error).message, /frames, expected/);
      return true;
    },
  );

  // And against a spec claiming a different frame size.
  await assert.rejects(
    () => verifyOutput(spec.output, { ...spec, width: 640 }, result.timeline, { countFrames: false, expectsSound: true }),
    (err: unknown) => {
      assert.match((err as Error).message, /frame size is 320×180, expected 640×180/);
      return true;
    },
  );
});

test('a font without the glyphs for the text stops the render', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-video-glyph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const spec = normaliseSpec(
    {
      output: join(dir, 'out.mp4'),
      width: 320, height: 180, fps: 24,
      // Latin fonts have no glyphs for these, so they would render as blank boxes.
      scenes: [{ duration: 1, title: '日本語のタイトル' }],
    },
    dir,
  );
  await assert.rejects(
    () => renderVideo(spec, { preset: 'ultrafast' }),
    (err: unknown) => {
      assert.match((err as Error).message, /cannot draw/);
      assert.match((err as Error).message, /allow-missing-glyphs/);
      return true;
    },
  );
  assert.equal(existsSync(spec.output), false, 'nothing should have been written');
});
