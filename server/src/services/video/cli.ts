/**
 * Command line entry point: `npm run video -- <spec.json> [options]`.
 */
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { loadSpecFile } from './spec.js';
import { buildTimeline } from './timeline.js';
import { FrameComposer } from './frames.js';
import { audioDurationSeconds } from './ffmpeg.js';
import { renderVideo } from './render.js';
import { sidecarsFor } from './captions.js';
import { VideoSpecError, VideoVerificationError, type VideoSpec } from './types.js';

const USAGE = `
Render a narrated explainer video from a JSON spec.

  npm run video -- <spec.json> [options]

Options
  --out <file>            Write the video here instead of the spec's "output".
  --check                 Validate the spec and print the timeline; render nothing.
  --still <frame> [file]  Render one frame to a PNG and stop. Fast layout preview.
  --fast                  Encode quicker and skip the frame-by-frame decode check.
  --crf <n>               x264 quality, 0-51, lower is better (default 18).
  --preset <name>         x264 speed preset (default medium).
  --allow-missing-glyphs  Render even if the font lacks glyphs for some text.
  --keep-work             Leave the intermediate audio files on disk.
  -h, --help              Show this message.
`.trimStart();

interface Args {
  spec: string;
  out?: string;
  check: boolean;
  still?: number;
  stillOut?: string;
  fast: boolean;
  crf?: number;
  preset?: string;
  allowMissingGlyphs: boolean;
  keepWork: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  const args: Args = { spec: '', check: false, fast: false, allowMissingGlyphs: false, keepWork: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new VideoSpecError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '-h': case '--help': return null;
      case '--out': args.out = next(); break;
      case '--check': args.check = true; break;
      case '--fast': args.fast = true; break;
      case '--keep-work': args.keepWork = true; break;
      case '--allow-missing-glyphs': args.allowMissingGlyphs = true; break;
      case '--crf': args.crf = Number(next()); break;
      case '--preset': args.preset = next(); break;
      case '--still': {
        args.still = Number(next());
        if (!Number.isInteger(args.still) || args.still < 0) {
          throw new VideoSpecError('--still needs a whole frame number, e.g. --still 0');
        }
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.stillOut = argv[++i];
        break;
      }
      default:
        if (arg.startsWith('-')) throw new VideoSpecError(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length !== 1) return null;
  args.spec = positional[0];
  return args;
}

function formatTime(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

async function printPlan(spec: VideoSpec): Promise<void> {
  const narrationSeconds = await Promise.all(
    spec.scenes.map((scene) => (scene.narration ? audioDurationSeconds(scene.narration.path, spec.audio.sampleRate) : null)),
  );
  const timeline = buildTimeline(spec, narrationSeconds);
  // Constructing the composer is what proves every piece of text fits its box.
  const composer = new FrameComposer(spec, timeline);

  console.log(`${spec.width}×${spec.height} at ${spec.fps} fps — ${timeline.totalFrames} frames, ` +
    `${formatTime(timeline.totalFrames / spec.fps)}`);
  console.log('');
  for (const timing of timeline.scenes) {
    const scene = spec.scenes[timing.index];
    const cues = timeline.cues.filter((c) => c.sceneIndex === timing.index).length;
    console.log(
      `  ${formatTime(timing.startFrame / spec.fps)} → ${formatTime(timing.endFrame / spec.fps)}  ` +
        `${timing.id.padEnd(16)} ${String(timing.frames).padStart(5)} frames  ` +
        `${scene.narration ? `narration ${formatTime(timing.narrationFrames / spec.fps)}` : 'silent'}` +
        `${cues ? `, ${cues} caption cue(s)` : ''}`,
    );
  }
  const missing = composer.missingGlyphs();
  console.log('');
  console.log(missing.length === 0
    ? '  All text fits its box and every character has a glyph.'
    : `  Warning: the font has no glyph for ${missing.map((c) => JSON.stringify(c)).join(', ')}.`);
  if (timeline.cues.length > 0) {
    console.log(`  ${timeline.cues.length} caption cue(s); an .srt and .vtt would be written beside the video.`);
  }
}

async function renderStill(spec: VideoSpec, frame: number, out: string | undefined): Promise<void> {
  const narrationSeconds = await Promise.all(
    spec.scenes.map((scene) => (scene.narration ? audioDurationSeconds(scene.narration.path, spec.audio.sampleRate) : null)),
  );
  const timeline = buildTimeline(spec, narrationSeconds);
  if (frame >= timeline.totalFrames) {
    throw new VideoSpecError(`Frame ${frame} is past the end; the video is ${timeline.totalFrames} frames long.`);
  }
  const composer = new FrameComposer(spec, timeline);
  const png = new Resvg(composer.svgForFrame(frame), { font: { loadSystemFonts: false } }).render().asPng();
  const target = resolve(out ?? spec.output.replace(/\.[^.]+$/, '') + `-frame-${frame}.png`);
  writeFileSync(target, png);
  const sceneIndex = composer.sceneIndexAt(frame);
  console.log(`Frame ${frame} (${formatTime(frame / spec.fps)}, scene "${timeline.scenes[sceneIndex].id}") → ${target}`);
}

export async function main(argv: string[]): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n`);
    console.error(USAGE);
    return 2;
  }
  if (!args) {
    console.log(USAGE);
    return argv.some((a) => a === '-h' || a === '--help') ? 0 : 2;
  }

  try {
    const spec = loadSpecFile(args.spec);
    if (args.out) spec.output = resolve(args.out);

    if (args.check) {
      await printPlan(spec);
      return 0;
    }
    if (args.still !== undefined) {
      await renderStill(spec, args.still, args.stillOut);
      return 0;
    }

    let lastPercent = -1;
    const result = await renderVideo(spec, {
      fullVerify: !args.fast,
      allowMissingGlyphs: args.allowMissingGlyphs,
      crf: args.crf,
      preset: args.preset ?? (args.fast ? 'veryfast' : undefined),
      keepWorkDir: args.keepWork,
      onProgress: (done, total) => {
        const percent = Math.floor((done / total) * 100);
        if (percent !== lastPercent && process.stderr.isTTY) {
          lastPercent = percent;
          process.stderr.write(`\r  rendering ${percent}% (${done}/${total} frames)`);
        }
      },
    });
    if (process.stderr.isTTY) process.stderr.write('\r'.padEnd(50) + '\r');

    console.log(`Wrote ${result.output}`);
    console.log(
      `  ${result.verification.width}×${result.verification.height} · ${result.verification.fps} fps · ` +
        `${result.verification.frames} frames · ${formatTime(result.durationSeconds)}`,
    );
    for (const check of result.verification.checks) console.log(`  verified: ${check}`);
    if (result.srtPath) console.log(`  captions: ${basename(result.srtPath)} and ${basename(result.srtPath).replace(/srt$/, 'vtt')}`);
    console.log(`  ${result.reusedFrames} of ${result.timeline.totalFrames} frames were unchanged and reused`);
    console.log(`  took ${(result.elapsedMs / 1000).toFixed(1)}s`);
    return 0;
  } catch (err) {
    if (err instanceof VideoVerificationError) {
      console.error('The video was encoded but did not match the spec — treat the file as bad:');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      return 1;
    }
    console.error((err as Error).message);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /video[/\\](cli|index)\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
