/**
 * Audio track assembly.
 *
 * The track is built per scene at exactly `sceneFrames × samplesPerFrame`
 * samples and the pieces are concatenated, so the audio is the same length as
 * the picture by construction rather than by luck. Offsets and lengths are
 * given to ffmpeg in *samples* (`adelay=…S`, `atrim=end_sample=…`), never in
 * seconds, because a millisecond-rounded offset drifts and a sample-exact one
 * cannot.
 *
 * Every piece is measured after it is written; a scene whose length is off by a
 * single sample fails the render rather than nudging everything after it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countAudioSamples, ffmpeg, run } from './ffmpeg.js';
import { VideoRenderError, type Timeline, type VideoSpec } from './types.js';

async function sampleCount(file: string, sampleRate: number): Promise<number> {
  return countAudioSamples(file, sampleRate);
}

export interface AudioTrack {
  path: string;
  samples: number;
  /** False when the spec has no narration and no music, so silence is expected. */
  expectsSound: boolean;
}

export async function buildAudioTrack(
  spec: VideoSpec,
  timeline: Timeline,
  workDir: string,
): Promise<AudioTrack> {
  const sampleRate = spec.audio.sampleRate;
  const samplesPerFrame = sampleRate / spec.fps;
  if (!Number.isInteger(samplesPerFrame)) {
    // spec.ts rejects this, so reaching here means the spec was built by hand.
    throw new VideoRenderError(
      `${spec.fps} fps does not divide ${sampleRate} Hz into whole samples per frame.`,
    );
  }

  mkdirSync(workDir, { recursive: true });
  const pieces: string[] = [];

  for (const timing of timeline.scenes) {
    const scene = spec.scenes[timing.index];
    const sceneSamples = timing.frames * samplesPerFrame;
    const piece = join(workDir, `scene-${String(timing.index).padStart(4, '0')}.wav`);

    if (scene.narration) {
      const delaySamples = (timing.narrationStartFrame - timing.startFrame) * samplesPerFrame;
      const filters = [
        `aresample=${sampleRate}:resampler=soxr`,
        'aformat=sample_fmts=s16:channel_layouts=stereo',
        scene.narration.gainDb !== 0 ? `volume=${scene.narration.gainDb}dB` : null,
        delaySamples > 0 ? `adelay=${delaySamples}S:all=1` : null,
        // Pad first, then cut: the result is exactly sceneSamples either way.
        'apad',
        `atrim=end_sample=${sceneSamples}`,
        'asetpts=N/SR/TB',
      ].filter((f): f is string => f !== null);

      await run(
        ffmpeg().path,
        ['-v', 'error', '-y', '-i', scene.narration.path,
         '-af', filters.join(','), '-ar', String(sampleRate), '-ac', '2',
         '-c:a', 'pcm_s16le', piece],
        `building audio for scenes[${timing.index}] ("${timing.id}")`,
      );
    } else {
      await run(
        ffmpeg().path,
        ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo`,
         '-af', `atrim=end_sample=${sceneSamples}`, '-ar', String(sampleRate), '-ac', '2',
         '-c:a', 'pcm_s16le', piece],
        `building silence for scenes[${timing.index}] ("${timing.id}")`,
      );
    }

    const written = await sampleCount(piece, sampleRate);
    if (written !== sceneSamples) {
      throw new VideoRenderError(
        `Audio for scenes[${timing.index}] ("${timing.id}") came out ${written} samples long, expected ` +
          `${sceneSamples} (${timing.frames} frames). Refusing to continue with audio that would drift.`,
      );
    }
    pieces.push(piece);
  }

  const listFile = join(workDir, 'scenes.txt');
  writeFileSync(listFile, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

  const narrationTrack = join(workDir, 'narration.wav');
  await run(
    ffmpeg().path,
    ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
     '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_s16le', narrationTrack],
    'joining the scene audio',
  );

  const expectedSamples = timeline.totalFrames * samplesPerFrame;
  const joined = await sampleCount(narrationTrack, sampleRate);
  if (joined !== expectedSamples) {
    throw new VideoRenderError(
      `The joined audio track is ${joined} samples, expected ${expectedSamples} for ` +
        `${timeline.totalFrames} frames at ${spec.fps} fps.`,
    );
  }

  const hasNarration = spec.scenes.some((scene) => scene.narration !== null);
  if (!spec.audio.music) {
    return { path: narrationTrack, samples: joined, expectsSound: hasNarration };
  }

  const mixed = join(workDir, 'mixed.wav');
  await run(
    ffmpeg().path,
    ['-v', 'error', '-y',
     '-i', narrationTrack,
     '-stream_loop', '-1', '-i', spec.audio.music.path,
     '-filter_complex',
     `[1:a]aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=stereo,` +
       `volume=${spec.audio.music.gainDb}dB,atrim=end_sample=${expectedSamples},asetpts=N/SR/TB[music];` +
       // normalize=0 keeps the narration at its own level instead of halving it.
       `[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]`,
     '-map', '[out]', '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_s16le', mixed],
    'mixing the music bed',
  );

  const mixedSamples = await sampleCount(mixed, sampleRate);
  if (mixedSamples !== expectedSamples) {
    throw new VideoRenderError(
      `The mixed audio track is ${mixedSamples} samples, expected ${expectedSamples}.`,
    );
  }
  return { path: mixed, samples: mixedSamples, expectsSound: true };
}
