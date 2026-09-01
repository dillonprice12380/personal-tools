/**
 * Spec loading, validation and normalisation.
 *
 * Everything that can be checked before a single frame is rendered is checked
 * here, and reported with the exact path of the offending field. A render that
 * is going to come out wrong should fail in the first second, not after five
 * minutes of encoding.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  type AudioOptions,
  type Background,
  type CaptionCueInput,
  type CaptionOptions,
  type NormalisedScene,
  type Preset,
  type PresetName,
  type Theme,
  type VideoSpec,
  type VideoSpecInput,
  VideoSpecError,
} from './types.js';
import { resolveFontFile } from './fonts.js';

export const PRESETS: Record<PresetName, Preset> = {
  youtube: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  shorts: { width: 1080, height: 1920 },
  tiktok: { width: 1080, height: 1920 },
  reels: { width: 1080, height: 1920 },
};

/**
 * Frame rates whose audio period is a whole number of samples at 48 kHz.
 * Anything else accumulates a sub-sample error every frame, which is how a
 * long video ends up with its narration drifting off the picture.
 */
export const SUPPORTED_FPS = [24, 25, 30, 50, 60] as const;

const DEFAULT_SAMPLE_RATE = 48000;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

class Problems {
  private readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
  get length(): number {
    return this.list.length;
  }
  throwIfAny(): void {
    if (this.list.length > 0) {
      throw new VideoSpecError(
        `The video spec has ${this.list.length} problem(s):\n  - ${this.list.join('\n  - ')}`,
      );
    }
  }
}

function num(value: unknown, path: string, problems: Problems, opts: {
  fallback?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}): number {
  if (value === undefined || value === null) {
    if (opts.fallback === undefined) {
      problems.add(path, 'is required');
      return 0;
    }
    return opts.fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(path, `must be a number, got ${JSON.stringify(value)}`);
    return opts.fallback ?? 0;
  }
  if (opts.integer && !Number.isInteger(value)) {
    problems.add(path, `must be a whole number, got ${value}`);
  }
  if (opts.min !== undefined && value < opts.min) problems.add(path, `must be at least ${opts.min}, got ${value}`);
  if (opts.max !== undefined && value > opts.max) problems.add(path, `must be at most ${opts.max}, got ${value}`);
  return value;
}

function color(value: unknown, path: string, problems: Problems, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    problems.add(path, `must be a hex colour such as "#1b2a4a" or "#000000cc", got ${JSON.stringify(value)}`);
    return fallback;
  }
  return value;
}

function existingFile(value: string, path: string, baseDir: string, problems: Problems): string {
  const full = isAbsolute(value) ? value : resolve(baseDir, value);
  if (!existsSync(full)) {
    problems.add(path, `file not found: ${full}`);
  } else if (!statSync(full).isFile()) {
    problems.add(path, `is not a file: ${full}`);
  }
  return full;
}

function background(
  value: Background | undefined,
  path: string,
  baseDir: string,
  problems: Problems,
  fallback: Background,
): Background {
  if (value === undefined) return fallback;
  if (typeof value !== 'object' || value === null) {
    problems.add(path, 'must be an object');
    return fallback;
  }
  switch (value.type) {
    case 'solid':
      return { type: 'solid', color: color(value.color, `${path}.color`, problems, '#0b1220') };
    case 'gradient':
      return {
        type: 'gradient',
        from: color(value.from, `${path}.from`, problems, '#0b1220'),
        to: color(value.to, `${path}.to`, problems, '#1b2a4a'),
        angle: num(value.angle, `${path}.angle`, problems, { fallback: 135, min: 0, max: 360 }),
      };
    case 'image':
      return {
        type: 'image',
        path: existingFile(String(value.path ?? ''), `${path}.path`, baseDir, problems),
        fit: value.fit === 'contain' ? 'contain' : 'cover',
        dim: num(value.dim, `${path}.dim`, problems, { fallback: 0.35, min: 0, max: 1 }),
        kenBurns: num(value.kenBurns, `${path}.kenBurns`, problems, { fallback: 0, min: 0, max: 0.5 }),
      };
    default:
      problems.add(path, `unknown type ${JSON.stringify((value as { type?: unknown }).type)}; expected solid, gradient or image`);
      return fallback;
  }
}

function captionCues(
  value: CaptionCueInput[] | undefined,
  path: string,
  problems: Problems,
): CaptionCueInput[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    problems.add(path, 'must be an array of cues');
    return null;
  }
  const cues: CaptionCueInput[] = [];
  let previousEnd = -Infinity;
  value.forEach((cue, i) => {
    const cuePath = `${path}[${i}]`;
    const start = num(cue?.start, `${cuePath}.start`, problems, { min: 0 });
    const end = num(cue?.end, `${cuePath}.end`, problems, { min: 0 });
    const text = typeof cue?.text === 'string' ? cue.text.trim() : '';
    if (!text) problems.add(`${cuePath}.text`, 'is required and must be a non-empty string');
    if (end <= start) problems.add(cuePath, `end (${end}s) must be greater than start (${start}s)`);
    if (start < previousEnd) {
      problems.add(cuePath, `starts at ${start}s, before the previous cue ends at ${previousEnd}s; cues must not overlap`);
    }
    previousEnd = end;
    cues.push({ start, end, text });
  });
  return cues;
}

export function loadSpecFile(specPath: string): VideoSpec {
  const full = resolve(specPath);
  if (!existsSync(full)) throw new VideoSpecError(`Spec file not found: ${full}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw new VideoSpecError(`Could not parse ${full} as JSON: ${(err as Error).message}`);
  }
  return normaliseSpec(raw as VideoSpecInput, dirname(full));
}

export function normaliseSpec(input: VideoSpecInput, baseDir: string): VideoSpec {
  const problems = new Problems();
  if (typeof input !== 'object' || input === null) {
    throw new VideoSpecError('The spec must be a JSON object.');
  }

  const preset = input.preset ? PRESETS[input.preset] : undefined;
  if (input.preset && !preset) {
    problems.add('preset', `unknown preset ${JSON.stringify(input.preset)}; expected one of ${Object.keys(PRESETS).join(', ')}`);
  }

  const width = num(input.width ?? preset?.width, 'width', problems, {
    fallback: PRESETS.youtube.width, min: 128, max: 7680, integer: true,
  });
  const height = num(input.height ?? preset?.height, 'height', problems, {
    fallback: PRESETS.youtube.height, min: 128, max: 4320, integer: true,
  });
  // yuv420p subsamples chroma 2×2; odd dimensions are rejected by the encoder.
  if (width % 2 !== 0) problems.add('width', `must be even for H.264 output, got ${width}`);
  if (height % 2 !== 0) problems.add('height', `must be even for H.264 output, got ${height}`);

  const fps = num(input.fps, 'fps', problems, { fallback: 30, integer: true, min: 1 });
  const sampleRate = num(input.audio?.sampleRate, 'audio.sampleRate', problems, {
    fallback: DEFAULT_SAMPLE_RATE, min: 8000, max: 192000, integer: true,
  });
  if (Number.isInteger(fps) && sampleRate % fps !== 0) {
    problems.add(
      'fps',
      `${fps} fps does not divide the ${sampleRate} Hz audio into whole samples per frame, so audio and ` +
        `picture would drift apart. Use one of ${SUPPORTED_FPS.join(', ')}.`,
    );
  }

  const themeInput = input.theme ?? {};
  const defaultBackground: Background = { type: 'gradient', from: '#0b1220', to: '#1b2a4a', angle: 135 };
  const shortEdge = Math.min(width, height);

  let fontFile = '';
  let boldFontFile = '';
  try {
    fontFile = resolveFontFile(themeInput.fontFile, baseDir, 'regular');
  } catch (err) {
    problems.add('theme.fontFile', (err as Error).message);
  }
  try {
    boldFontFile = resolveFontFile(themeInput.boldFontFile ?? themeInput.fontFile, baseDir, 'bold');
  } catch {
    // A bold face is a nicety; fall back to the regular one rather than failing.
    boldFontFile = fontFile;
  }

  const titleSize = num(themeInput.titleSize, 'theme.titleSize', problems, {
    fallback: Math.round(shortEdge * 0.075), min: 8,
  });
  const bodySize = num(themeInput.bodySize, 'theme.bodySize', problems, {
    fallback: Math.round(shortEdge * 0.042), min: 8,
  });
  // The floor must stay below the body size, or every scene would fail to lay
  // out on a small frame before the renderer got a chance to shrink anything.
  const minFontSize = num(themeInput.minFontSize, 'theme.minFontSize', problems, {
    fallback: Math.max(6, Math.min(Math.round(shortEdge * 0.02), Math.floor(bodySize * 0.7))),
    min: 6,
  });

  const theme: Theme = {
    background: background(themeInput.background, 'theme.background', baseDir, problems, defaultBackground),
    fontFile,
    boldFontFile: boldFontFile || fontFile,
    titleColor: color(themeInput.titleColor, 'theme.titleColor', problems, '#ffffff'),
    bodyColor: color(themeInput.bodyColor, 'theme.bodyColor', problems, '#cbd5e1'),
    accentColor: color(themeInput.accentColor, 'theme.accentColor', problems, '#38bdf8'),
    captionColor: color(themeInput.captionColor, 'theme.captionColor', problems, '#ffffff'),
    captionBackground: color(themeInput.captionBackground, 'theme.captionBackground', problems, '#000000b3'),
    safeArea: num(themeInput.safeArea, 'theme.safeArea', problems, { fallback: 0.06, min: 0, max: 0.4 }),
    titleSize,
    bodySize,
    captionSize: num(themeInput.captionSize, 'theme.captionSize', problems, {
      fallback: Math.round(shortEdge * 0.04), min: 8,
    }),
    minFontSize,
    align: themeInput.align === 'left' ? 'left' : 'center',
  };
  if (theme.minFontSize > theme.bodySize) {
    problems.add('theme.minFontSize', `(${theme.minFontSize}) is larger than theme.bodySize (${theme.bodySize})`);
  }

  const captionsInput = input.captions ?? {};
  const captions: CaptionOptions = {
    enabled: captionsInput.enabled !== false,
    maxCharsPerLine: num(captionsInput.maxCharsPerLine, 'captions.maxCharsPerLine', problems, {
      fallback: width >= height ? 42 : 30, min: 8, max: 120, integer: true,
    }),
    maxLines: num(captionsInput.maxLines, 'captions.maxLines', problems, {
      fallback: 2, min: 1, max: 4, integer: true,
    }),
    minCueSeconds: num(captionsInput.minCueSeconds, 'captions.minCueSeconds', problems, {
      fallback: 0.7, min: 0.1, max: 10,
    }),
    sidecar: captionsInput.sidecar !== false,
  };

  const audio: AudioOptions = {
    music: null,
    sampleRate,
  };
  if (input.audio?.music) {
    const musicPath = typeof input.audio.music === 'string' ? input.audio.music : input.audio.music.path;
    audio.music = {
      path: existingFile(String(musicPath ?? ''), 'audio.music.path', baseDir, problems),
      gainDb: num(
        typeof input.audio.music === 'string' ? undefined : input.audio.music.gainDb,
        'audio.music.gainDb', problems, { fallback: -22, min: -60, max: 12 },
      ),
    };
  }

  const fade = num(input.fade, 'fade', problems, { fallback: 0.25, min: 0, max: 5 });

  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    problems.add('scenes', 'must be a non-empty array');
    problems.throwIfAny();
  }

  const seenIds = new Set<string>();
  const scenes: NormalisedScene[] = input.scenes.map((sceneInput, index) => {
    const path = `scenes[${index}]`;
    const scene = sceneInput ?? ({} as typeof sceneInput);
    let id = typeof scene.id === 'string' && scene.id.trim() ? scene.id.trim() : `scene-${index + 1}`;
    if (seenIds.has(id)) {
      problems.add(`${path}.id`, `duplicate scene id ${JSON.stringify(id)}`);
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    const narrationInput = typeof scene.narration === 'string' ? { path: scene.narration } : scene.narration;
    const narration = narrationInput
      ? {
          path: existingFile(String(narrationInput.path ?? ''), `${path}.narration.path`, baseDir, problems),
          text: typeof narrationInput.text === 'string' ? narrationInput.text : '',
          gainDb: num(narrationInput.gainDb, `${path}.narration.gainDb`, problems, {
            fallback: 0, min: -60, max: 12,
          }),
        }
      : null;

    const hasDuration = scene.duration !== undefined;
    if (!narration && !hasDuration) {
      problems.add(path, 'needs either a narration file or an explicit duration in seconds');
    }
    const duration = hasDuration
      ? num(scene.duration, `${path}.duration`, problems, { min: 0.1, max: 3600 })
      : null;

    const padStart = num(scene.padStart, `${path}.padStart`, problems, { fallback: 0.2, min: 0, max: 30 });
    const padEnd = num(scene.padEnd, `${path}.padEnd`, problems, { fallback: 0.4, min: 0, max: 30 });

    const imageInput = typeof scene.image === 'string' ? { path: scene.image } : scene.image;
    const image = imageInput
      ? {
          path: existingFile(String(imageInput.path ?? ''), `${path}.image.path`, baseDir, problems),
          fit: imageInput.fit === 'cover' ? ('cover' as const) : ('contain' as const),
          maxHeight: num(imageInput.maxHeight, `${path}.image.maxHeight`, problems, {
            fallback: 0.55, min: 0.05, max: 1,
          }),
        }
      : null;

    const bullets = Array.isArray(scene.bullets)
      ? scene.bullets.map((b, i) => {
          if (typeof b !== 'string' || !b.trim()) {
            problems.add(`${path}.bullets[${i}]`, 'must be a non-empty string');
            return '';
          }
          return b.trim();
        }).filter(Boolean)
      : [];

    const hasContent =
      Boolean(scene.title) || Boolean(scene.body) || bullets.length > 0 || image !== null ||
      narration !== null || Boolean(scene.captions) || Boolean(scene.captionsFrom);
    if (!hasContent) {
      problems.add(path, 'is empty — give it a title, body, bullets, an image, narration or captions');
    }

    let cues = captionCues(scene.captions, `${path}.captions`, problems);
    if (!cues && scene.captionsFrom) {
      const srtPath = existingFile(String(scene.captionsFrom), `${path}.captionsFrom`, baseDir, problems);
      if (existsSync(srtPath)) {
        try {
          cues = parseSrt(readFileSync(srtPath, 'utf8'));
        } catch (err) {
          problems.add(`${path}.captionsFrom`, (err as Error).message);
        }
      }
    }

    return {
      id,
      index,
      narration,
      duration,
      padStart,
      padEnd,
      title: typeof scene.title === 'string' && scene.title.trim() ? scene.title.trim() : null,
      body: typeof scene.body === 'string' && scene.body.trim() ? scene.body.trim() : null,
      bullets,
      image,
      background: background(scene.background, `${path}.background`, baseDir, problems, theme.background),
      captions: cues,
    };
  });

  const output = input.output
    ? isAbsolute(input.output) ? input.output : resolve(baseDir, input.output)
    : resolve(baseDir, 'video.mp4');

  problems.throwIfAny();

  return { output, width, height, fps, fade, theme, audio, captions, scenes, baseDir };
}

/** Parse SubRip cue times and text. Times are taken as scene-relative seconds. */
export function parseSrt(text: string): CaptionCueInput[] {
  const cues: CaptionCueInput[] = [];
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) throw new Error(`SRT block has no timing line:\n${block}`);
    const match = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(lines[timeIndex]);
    if (!match) throw new Error(`Could not read the timing line: ${lines[timeIndex]}`);
    const body = lines.slice(timeIndex + 1).join(' ').trim();
    if (!body) throw new Error(`SRT cue at ${lines[timeIndex]} has no text`);
    cues.push({ start: srtTimeToSeconds(match[1]), end: srtTimeToSeconds(match[2]), text: body });
  }
  return cues;
}

function srtTimeToSeconds(value: string): number {
  const [h, m, rest] = value.split(':');
  const [s, ms = '0'] = rest.split(/[,.]/);
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}
