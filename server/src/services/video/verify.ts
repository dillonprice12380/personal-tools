/**
 * Post-render verification.
 *
 * The point of this module is that the render does not get to report success on
 * its own say-so. The finished file is decoded and every property the spec
 * asked for is checked against it — frame count by counting frames, not by
 * trusting the container header, because a header can be right while the
 * stream is wrong.
 */
import { peakLevelDb, probe } from './ffmpeg.js';
import { VideoVerificationError, type Timeline, type VideoSpec } from './types.js';

export interface VerificationReport {
  width: number;
  height: number;
  fps: number;
  frames: number;
  videoSeconds: number;
  audioSeconds: number;
  peakDb: number | null;
  checks: string[];
}

function parseRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

export async function verifyOutput(
  file: string,
  spec: VideoSpec,
  timeline: Timeline,
  options: { countFrames: boolean; expectsSound: boolean },
): Promise<VerificationReport> {
  const problems: string[] = [];
  const checks: string[] = [];
  const result = await probe(file, options.countFrames);

  const video = result.streams.find((s) => s.codec_type === 'video');
  const audio = result.streams.find((s) => s.codec_type === 'audio');

  if (!video) problems.push('the output has no video stream');
  if (!audio) problems.push('the output has no audio stream');

  const expectedSeconds = timeline.totalFrames / spec.fps;
  let frames = 0;
  let videoSeconds = 0;

  if (video) {
    if (video.width !== spec.width || video.height !== spec.height) {
      problems.push(`frame size is ${video.width}×${video.height}, expected ${spec.width}×${spec.height}`);
    } else {
      checks.push(`frame size ${spec.width}×${spec.height}`);
    }

    const rate = parseRate(video.avg_frame_rate);
    if (rate === null || Math.abs(rate - spec.fps) > 0.001) {
      problems.push(`average frame rate is ${video.avg_frame_rate ?? 'unknown'}, expected ${spec.fps}`);
    } else {
      checks.push(`constant ${spec.fps} fps`);
    }

    const counted = options.countFrames ? Number(video.nb_read_frames) : Number(video.nb_frames);
    frames = Number.isFinite(counted) ? counted : 0;
    if (!Number.isFinite(counted)) {
      problems.push('could not determine how many frames the output contains');
    } else if (counted !== timeline.totalFrames) {
      problems.push(
        `the output has ${counted} frames, expected ${timeline.totalFrames} ` +
          `(a difference of ${counted - timeline.totalFrames} frames)`,
      );
    } else {
      checks.push(
        `${counted} frames, ${options.countFrames ? 'counted by decoding' : 'from the container index'}`,
      );
    }
    videoSeconds = frames / spec.fps;
  }

  let audioSeconds = 0;
  if (audio) {
    const sampleRate = Number(audio.sample_rate);
    if (sampleRate !== spec.audio.sampleRate) {
      problems.push(`audio sample rate is ${audio.sample_rate}, expected ${spec.audio.sampleRate}`);
    }
    audioSeconds = Number(audio.duration);
    if (!Number.isFinite(audioSeconds)) {
      audioSeconds = Number(result.format.duration);
    }
    if (Number.isFinite(audioSeconds)) {
      // One frame of slack: the AAC encoder pads the final packet.
      const tolerance = 2 / spec.fps;
      const drift = Math.abs(audioSeconds - expectedSeconds);
      if (drift > tolerance) {
        problems.push(
          `the audio is ${audioSeconds.toFixed(3)}s but the picture is ${expectedSeconds.toFixed(3)}s ` +
            `— a drift of ${drift.toFixed(3)}s`,
        );
      } else {
        checks.push(`audio within ${drift.toFixed(3)}s of the picture`);
      }
    } else {
      problems.push('could not determine the audio duration');
    }
  }

  let peakDb: number | null = null;
  if (options.expectsSound) {
    peakDb = await peakLevelDb(file);
    if (peakDb === null) {
      problems.push('could not measure the audio level of the output');
    } else if (peakDb === Number.NEGATIVE_INFINITY || peakDb < -60) {
      problems.push(
        `the audio track is silent (peak ${peakDb === Number.NEGATIVE_INFINITY ? '-inf' : peakDb.toFixed(1)} dB) ` +
          `even though the spec has narration or music`,
      );
    } else if (peakDb > -0.1) {
      problems.push(`the audio clips (peak ${peakDb.toFixed(1)} dB); lower narration.gainDb or audio.music.gainDb`);
    } else {
      checks.push(`audio peaks at ${peakDb.toFixed(1)} dB`);
    }
  }

  if (problems.length > 0) throw new VideoVerificationError(problems);

  return {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    frames,
    videoSeconds,
    audioSeconds,
    peakDb,
    checks,
  };
}
