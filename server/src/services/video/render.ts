/**
 * The renderer.
 *
 * Order of operations, and why:
 *   1. measure every narration file            — timing depends on real lengths
 *   2. build the frame timeline                — fixes every boundary in frames
 *   3. lay out every scene and check the fonts — fails before any encoding
 *   4. build the audio track                   — verified sample-exact
 *   5. rasterise frames straight into ffmpeg   — no numbered-file bookkeeping
 *   6. verify the finished file against step 2 — success is proven, not assumed
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { buildAudioTrack } from './audio.js';
import { sidecarsFor } from './captions.js';
import { audioDurationSeconds, cfrFlags, ffmpeg, tail } from './ffmpeg.js';
import { FrameComposer } from './frames.js';
import { buildTimeline } from './timeline.js';
import { VideoRenderError, type Timeline, type VideoSpec } from './types.js';
import { verifyOutput, type VerificationReport } from './verify.js';

export interface RenderOptions {
  /** Decode the finished file to count frames exactly. Default true. */
  fullVerify?: boolean;
  /** Render outlines even when a font lacks glyphs for some characters. */
  allowMissingGlyphs?: boolean;
  /** x264 quality, lower is better. Default 18. */
  crf?: number;
  preset?: string;
  onProgress?: (done: number, total: number) => void;
  /** Keep the intermediate audio in place for inspection. */
  keepWorkDir?: boolean;
}

export interface RenderResult {
  output: string;
  srtPath: string | null;
  vttPath: string | null;
  timeline: Timeline;
  durationSeconds: number;
  verification: VerificationReport;
  /** Frames that were byte-identical to their predecessor and so reused. */
  reusedFrames: number;
  elapsedMs: number;
}

export async function renderVideo(spec: VideoSpec, options: RenderOptions = {}): Promise<RenderResult> {
  const started = Date.now();

  const narrationSeconds = await Promise.all(
    spec.scenes.map((scene) => (scene.narration ? audioDurationSeconds(scene.narration.path, spec.audio.sampleRate) : null)),
  );
  const timeline = buildTimeline(spec, narrationSeconds);
  if (timeline.totalFrames < 1) {
    throw new VideoRenderError('The timeline came out empty; every scene has a length of zero frames.');
  }

  const composer = new FrameComposer(spec, timeline);

  const missing = composer.missingGlyphs();
  if (missing.length > 0 && !options.allowMissingGlyphs) {
    throw new VideoRenderError(
      `The chosen font cannot draw ${missing.length} character(s) used in this video: ` +
        `${missing.map((c) => JSON.stringify(c)).join(', ')}. They would come out as blank boxes. ` +
        `Point theme.fontFile at a font that covers them, or pass --allow-missing-glyphs to render anyway.`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), 'helm-video-'));
  try {
    const audio = await buildAudioTrack(spec, timeline, workDir);

    mkdirSync(dirname(spec.output), { recursive: true });
    const reusedFrames = await encode(spec, timeline, composer, audio.path, options);

    const verification = await verifyOutput(spec.output, spec, timeline, {
      countFrames: options.fullVerify !== false,
      expectsSound: audio.expectsSound,
    });

    let srtPath: string | null = null;
    let vttPath: string | null = null;
    if (spec.captions.enabled && spec.captions.sidecar && timeline.cues.length > 0) {
      const { srt, vtt } = sidecarsFor(timeline);
      srtPath = spec.output.replace(/\.[^.]+$/, '') + '.srt';
      vttPath = spec.output.replace(/\.[^.]+$/, '') + '.vtt';
      writeFileSync(srtPath, srt, 'utf8');
      writeFileSync(vttPath, vtt, 'utf8');
    }

    return {
      output: spec.output,
      srtPath,
      vttPath,
      timeline,
      durationSeconds: timeline.totalFrames / spec.fps,
      verification,
      reusedFrames,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (!options.keepWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Rasterise every frame and stream it into ffmpeg.
 *
 * Frames are piped rather than written as numbered files: there is no gap to
 * mis-number and no glob for ffmpeg to misread. `-frames:v` caps the stream at
 * the exact count the timeline calls for, so a bug here becomes a short pipe
 * and a hard failure rather than a video that is quietly a few frames long.
 */
async function encode(
  spec: VideoSpec,
  timeline: Timeline,
  composer: FrameComposer,
  audioPath: string,
  options: RenderOptions,
): Promise<number> {
  const args = [
    '-v', 'error',
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(spec.fps),
    '-i', 'pipe:0',
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', options.preset ?? 'medium',
    '-crf', String(options.crf ?? 18),
    '-pix_fmt', 'yuv420p',
    '-r', String(spec.fps),
    ...cfrFlags(),
    '-frames:v', String(timeline.totalFrames),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', String(spec.audio.sampleRate),
    '-ac', '2',
    '-movflags', '+faststart',
    spec.output,
  ];

  const child = spawn(ffmpeg().path, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

  const finished = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new VideoRenderError(`Could not start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new VideoRenderError(`ffmpeg exited with code ${code} while encoding:\n${tail(stderr)}`));
    });
  });

  let reused = 0;
  let pipeBroke = false;
  child.stdin.on('error', () => {
    // ffmpeg died; `finished` carries the real error, so stop writing quietly.
    pipeBroke = true;
  });

  try {
    let previousSvg: string | null = null;
    let previousPng: Buffer | null = null;

    for (let frame = 0; frame < timeline.totalFrames && !pipeBroke; frame++) {
      const svg = composer.svgForFrame(frame);
      let png: Buffer;
      if (svg === previousSvg && previousPng) {
        png = previousPng;
        reused += 1;
      } else {
        png = renderSvg(svg, frame);
        previousSvg = svg;
        previousPng = png;
      }
      if (!child.stdin.write(png)) {
        await new Promise<void>((resolve) => child.stdin.once('drain', resolve));
      }
      options.onProgress?.(frame + 1, timeline.totalFrames);
    }
  } finally {
    child.stdin.end();
  }

  await finished;
  return reused;
}

function renderSvg(svg: string, frame: number): Buffer {
  try {
    // Fonts are already outlines by this point, so the text engine is unused.
    return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
  } catch (err) {
    throw new VideoRenderError(`Could not rasterise frame ${frame}: ${(err as Error).message}`);
  }
}
