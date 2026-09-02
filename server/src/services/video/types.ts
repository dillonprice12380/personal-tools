/**
 * Video module — type definitions.
 *
 * The spec is the single source of truth for a render. Everything downstream
 * (timing, layout, encoding, verification) is derived from a *normalised* spec,
 * never re-read from the raw JSON, so there is exactly one interpretation of
 * any input.
 */

/** Frame sizes that keep `width % 2 === 0` (required by yuv420p). */
export type PresetName = 'youtube' | 'square' | 'vertical' | 'shorts' | 'tiktok' | 'reels';

export interface Preset {
  width: number;
  height: number;
}

export type Background =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; from: string; to: string; angle?: number }
  | { type: 'image'; path: string; fit?: 'cover' | 'contain'; dim?: number; kenBurns?: number };

export interface SceneImage {
  path: string;
  fit?: 'cover' | 'contain';
  /** Fraction of the content area height the image may occupy (0–1). */
  maxHeight?: number;
}

export interface Narration {
  path: string;
  /** Spoken words. Used to derive caption cues when none are supplied. */
  text?: string;
  gainDb?: number;
}

export interface CaptionCueInput {
  /** Seconds, relative to the start of the scene. */
  start: number;
  end: number;
  text: string;
}

export interface SceneInput {
  id?: string;
  narration?: Narration | string;
  /** Explicit scene length in seconds. Required when there is no narration. */
  duration?: number;
  /** Silent lead-in / tail added around the narration, in seconds. */
  padStart?: number;
  padEnd?: number;
  title?: string;
  body?: string;
  bullets?: string[];
  image?: SceneImage | string;
  background?: Background;
  captions?: CaptionCueInput[];
  /** Path to an .srt whose cue times are relative to this scene. */
  captionsFrom?: string;
}

export interface ThemeInput {
  background?: Background;
  fontFile?: string;
  boldFontFile?: string;
  titleColor?: string;
  bodyColor?: string;
  accentColor?: string;
  captionColor?: string;
  captionBackground?: string;
  /** Fraction of the shorter frame edge kept clear of content (0–0.4). */
  safeArea?: number;
  titleSize?: number;
  bodySize?: number;
  captionSize?: number;
  minFontSize?: number;
  align?: 'left' | 'center';
}

export interface CaptionOptionsInput {
  enabled?: boolean;
  maxCharsPerLine?: number;
  maxLines?: number;
  /** Shortest a cue may be, in seconds. Guards against unreadable flashes. */
  minCueSeconds?: number;
  /** Write .srt and .vtt sidecars next to the video. */
  sidecar?: boolean;
}

export interface AudioOptionsInput {
  /** A bare path is accepted as shorthand for `{ path }`. */
  music?: { path: string; gainDb?: number } | string;
  sampleRate?: number;
}

export interface VideoSpecInput {
  output?: string;
  preset?: PresetName;
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds of fade-in/out applied to each scene's content. */
  fade?: number;
  theme?: ThemeInput;
  audio?: AudioOptionsInput;
  captions?: CaptionOptionsInput;
  scenes: SceneInput[];
}

/* ------------------------------------------------------------------ */
/* Normalised forms — every optional field resolved, every path absolute */
/* ------------------------------------------------------------------ */

export interface Theme {
  background: Background;
  fontFile: string;
  boldFontFile: string;
  titleColor: string;
  bodyColor: string;
  accentColor: string;
  captionColor: string;
  captionBackground: string;
  safeArea: number;
  titleSize: number;
  bodySize: number;
  captionSize: number;
  minFontSize: number;
  align: 'left' | 'center';
}

export interface CaptionOptions {
  enabled: boolean;
  maxCharsPerLine: number;
  maxLines: number;
  minCueSeconds: number;
  sidecar: boolean;
}

export interface AudioOptions {
  music: { path: string; gainDb: number } | null;
  sampleRate: number;
}

export interface NormalisedScene {
  id: string;
  index: number;
  narration: { path: string; text: string; gainDb: number } | null;
  duration: number | null;
  padStart: number;
  padEnd: number;
  title: string | null;
  body: string | null;
  bullets: string[];
  image: { path: string; fit: 'cover' | 'contain'; maxHeight: number } | null;
  background: Background;
  captions: CaptionCueInput[] | null;
}

export interface VideoSpec {
  output: string;
  width: number;
  height: number;
  fps: number;
  fade: number;
  theme: Theme;
  audio: AudioOptions;
  captions: CaptionOptions;
  scenes: NormalisedScene[];
  /** Directory the spec was loaded from; relative paths resolve against it. */
  baseDir: string;
}

/* ------------------------------------------------------------------ */
/* Timeline — everything below is measured in whole frames             */
/* ------------------------------------------------------------------ */

export interface Cue {
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  text: string;
  sceneIndex: number;
}

export interface SceneTiming {
  index: number;
  id: string;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  frames: number;
  /** Frame the narration audio starts on, absolute. */
  narrationStartFrame: number;
  narrationFrames: number;
}

export interface Timeline {
  fps: number;
  totalFrames: number;
  scenes: SceneTiming[];
  cues: Cue[];
}

export class VideoSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoSpecError';
  }
}

export class VideoRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoRenderError';
  }
}

export class VideoVerificationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Rendered video did not match the spec:\n  - ${problems.join('\n  - ')}`);
    this.name = 'VideoVerificationError';
    this.problems = problems;
  }
}
