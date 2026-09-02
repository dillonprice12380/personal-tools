/**
 * Caption sidecars.
 *
 * The cue times written here are the same integer frame boundaries the burnt-in
 * captions use, converted once at the edge. So the .srt next to the video is an
 * exact transcript of what is on screen — edit it, point the scene at it with
 * `captionsFrom`, and the next render matches it frame for frame.
 */
import type { Cue, Timeline } from './types.js';

function stamp(frame: number, fps: number, separator: ',' | '.'): string {
  const totalMs = Math.round((frame / fps) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

export function toSrt(cues: Cue[], fps: number): string {
  return cues
    .map((cue, i) =>
      `${i + 1}\n${stamp(cue.startFrame, fps, ',')} --> ${stamp(cue.endFrame, fps, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}

export function toVtt(cues: Cue[], fps: number): string {
  const body = cues
    .map((cue) => `${stamp(cue.startFrame, fps, '.')} --> ${stamp(cue.endFrame, fps, '.')}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function sidecarsFor(timeline: Timeline): { srt: string; vtt: string } {
  return { srt: toSrt(timeline.cues, timeline.fps), vtt: toVtt(timeline.cues, timeline.fps) };
}
