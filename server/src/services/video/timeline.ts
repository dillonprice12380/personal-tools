/**
 * Timing.
 *
 * Every duration in a render is an integer number of frames. Seconds are only
 * ever an input; the moment a narration length is known it is converted to
 * frames and never converted back for arithmetic. That is what keeps the
 * picture and the audio on the same clock: the audio track is built from the
 * same frame counts, and one frame at 30 fps is exactly 1600 samples at 48 kHz.
 *
 * This module is pure — it takes measured narration durations rather than
 * measuring them — so the timing rules can be tested without ffmpeg.
 */
import {
  type Cue,
  type SceneTiming,
  type Timeline,
  type VideoSpec,
  VideoSpecError,
} from './types.js';
import { chunkForCaptions, normaliseWhitespace } from './text.js';

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/**
 * Split `total` into integer parts proportional to `weights`, summing to
 * exactly `total`. Uses the largest-remainder method so the rounding error
 * cannot accumulate across cues.
 */
export function partition(weights: number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total < n) {
    throw new VideoSpecError(`Cannot split ${total} frames across ${n} caption cues; each cue needs at least one frame.`);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const safe = sum > 0 ? weights : weights.map(() => 1);
  const safeSum = sum > 0 ? sum : n;

  const exact = safe.map((w) => (w / safeSum) * total);
  const floors = exact.map((v) => Math.max(1, Math.floor(v)));
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  // Hand out what rounding left over, largest fractional part first; take back
  // from the largest parts if the per-cue minimum overshot the total.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value), value }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  let cursor = 0;
  while (remaining > 0) {
    floors[order[cursor % n].index] += 1;
    remaining -= 1;
    cursor += 1;
  }
  while (remaining < 0) {
    const candidates = floors
      .map((value, index) => ({ value, index }))
      .filter((c) => c.value > 1)
      .sort((a, b) => b.value - a.value || a.index - b.index);
    if (candidates.length === 0) break;
    floors[candidates[0].index] -= 1;
    remaining += 1;
  }
  return floors;
}

/** Longer for more text, with a little extra after a sentence-ending pause. */
function cueWeight(text: string): number {
  const clean = normaliseWhitespace(text);
  const pause = /[.!?]$/.test(clean) ? 6 : /[,;:—–]$/.test(clean) ? 3 : 0;
  return Math.max(1, clean.length + pause);
}

function deriveCues(
  chunks: string[],
  startFrame: number,
  frames: number,
  minCueFrames: number,
  sceneIndex: number,
): Cue[] {
  if (chunks.length === 0 || frames <= 0) return [];

  // Merge chunks until every cue can hold the readable minimum. Merging is
  // deterministic: always fold the shortest chunk into its shorter neighbour.
  let working = [...chunks];
  const maxCues = Math.max(1, Math.floor(frames / Math.max(1, minCueFrames)));
  while (working.length > maxCues && working.length > 1) {
    let shortest = 0;
    for (let i = 1; i < working.length; i++) {
      if (working[i].length < working[shortest].length) shortest = i;
    }
    const before = shortest > 0 ? working[shortest - 1].length : Infinity;
    const after = shortest < working.length - 1 ? working[shortest + 1].length : Infinity;
    const mergeWithPrevious = before <= after;
    const target = mergeWithPrevious ? shortest - 1 : shortest;
    working = [
      ...working.slice(0, target),
      `${working[target]} ${working[target + 1]}`,
      ...working.slice(target + 2),
    ];
  }

  const lengths = partition(working.map(cueWeight), frames);
  const cues: Cue[] = [];
  let cursor = startFrame;
  for (let i = 0; i < working.length; i++) {
    cues.push({ startFrame: cursor, endFrame: cursor + lengths[i], text: working[i], sceneIndex });
    cursor += lengths[i];
  }
  return cues;
}

function explicitCues(
  spec: VideoSpec,
  sceneIndex: number,
  sceneStartFrame: number,
  sceneFrames: number,
): Cue[] {
  const scene = spec.scenes[sceneIndex];
  const cues: Cue[] = [];
  let previousEnd = sceneStartFrame;
  for (const cue of scene.captions ?? []) {
    const startFrame = sceneStartFrame + secondsToFrames(cue.start, spec.fps);
    let endFrame = sceneStartFrame + secondsToFrames(cue.end, spec.fps);
    if (endFrame <= startFrame) endFrame = startFrame + 1;
    if (startFrame < previousEnd) {
      throw new VideoSpecError(
        `scenes[${sceneIndex}].captions: cue "${cue.text.slice(0, 40)}" starts at ${cue.start}s, which lands on ` +
          `frame ${startFrame} — before the previous cue ends (frame ${previousEnd}). Cues must not overlap.`,
      );
    }
    if (endFrame > sceneStartFrame + sceneFrames) {
      throw new VideoSpecError(
        `scenes[${sceneIndex}].captions: cue "${cue.text.slice(0, 40)}" ends at ${cue.end}s but the scene is only ` +
          `${framesToSeconds(sceneFrames, spec.fps).toFixed(3)}s long. Lengthen the scene or shorten the cue.`,
      );
    }
    previousEnd = endFrame;
    cues.push({ startFrame, endFrame, text: cue.text, sceneIndex });
  }
  return cues;
}

/**
 * @param narrationSeconds measured length of each scene's narration, or null
 *        for scenes without narration. Must be one entry per scene.
 */
export function buildTimeline(spec: VideoSpec, narrationSeconds: (number | null)[]): Timeline {
  if (narrationSeconds.length !== spec.scenes.length) {
    throw new VideoSpecError(
      `Internal error: got ${narrationSeconds.length} narration durations for ${spec.scenes.length} scenes.`,
    );
  }
  const { fps } = spec;
  const minCueFrames = Math.max(1, secondsToFrames(spec.captions.minCueSeconds, fps));

  const scenes: SceneTiming[] = [];
  const cues: Cue[] = [];
  let startFrame = 0;

  spec.scenes.forEach((scene, index) => {
    const audioSeconds = narrationSeconds[index];
    const padStartFrames = secondsToFrames(scene.padStart, fps);
    const padEndFrames = secondsToFrames(scene.padEnd, fps);
    // Round narration up: a scene must never end mid-word.
    const audioFrames = audioSeconds === null ? 0 : Math.ceil(audioSeconds * fps);

    let sceneFrames: number;
    if (audioSeconds === null) {
      sceneFrames = Math.max(1, secondsToFrames(scene.duration as number, fps));
    } else {
      const naturalFrames = padStartFrames + audioFrames + padEndFrames;
      if (scene.duration === null) {
        sceneFrames = Math.max(1, naturalFrames);
      } else {
        const wanted = secondsToFrames(scene.duration, fps);
        if (wanted < naturalFrames) {
          throw new VideoSpecError(
            `scenes[${index}] ("${scene.id}"): duration is ${scene.duration}s (${wanted} frames) but the narration ` +
              `is ${audioSeconds.toFixed(3)}s plus ${scene.padStart}s lead-in and ${scene.padEnd}s tail, which needs ` +
              `${framesToSeconds(naturalFrames, fps).toFixed(3)}s. Raise the duration or remove it to fit the narration.`,
          );
        }
        sceneFrames = wanted;
      }
    }

    const timing: SceneTiming = {
      index,
      id: scene.id,
      startFrame,
      endFrame: startFrame + sceneFrames,
      frames: sceneFrames,
      narrationStartFrame: startFrame + (audioSeconds === null ? 0 : padStartFrames),
      narrationFrames: audioFrames,
    };
    scenes.push(timing);

    if (spec.captions.enabled) {
      if (scene.captions) {
        cues.push(...explicitCues(spec, index, startFrame, sceneFrames));
      } else if (scene.narration?.text && audioFrames > 0) {
        const chunks = chunkForCaptions(
          scene.narration.text,
          spec.captions.maxCharsPerLine,
          spec.captions.maxLines,
        );
        cues.push(...deriveCues(chunks, timing.narrationStartFrame, audioFrames, minCueFrames, index));
      }
    }

    startFrame += sceneFrames;
  });

  return { fps, totalFrames: startFrame, scenes, cues };
}

/** Cue active on `frame`, or null. Cue ranges never overlap, so at most one. */
export function cueAt(cues: Cue[], frame: number): Cue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (frame < cue.startFrame) hi = mid - 1;
    else if (frame >= cue.endFrame) lo = mid + 1;
    else return cue;
  }
  return null;
}
