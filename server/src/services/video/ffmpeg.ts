/**
 * ffmpeg / ffprobe access.
 *
 * Both binaries are resolved once and their versions recorded, because the
 * correct flag for constant-frame-rate output changed name in ffmpeg 5. Getting
 * that wrong is one of the ways a render silently drifts out of sync, so we
 * detect rather than assume.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { VideoRenderError } from './types.js';

const require_ = createRequire(import.meta.url);

export interface Binary {
  path: string;
  majorVersion: number;
}

let ffmpegBin: Binary | null = null;
let ffprobeBin: Binary | null = null;

function optionalModulePath(spec: string, pick: (mod: unknown) => unknown): string | null {
  try {
    const mod = require_(spec) as unknown;
    const value = pick(mod);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function versionOf(bin: string): number | null {
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  const match = /version\s+n?(\d+)\./.exec(res.stdout ?? '');
  return match ? Number(match[1]) : 0;
}

function resolve(kind: 'ffmpeg' | 'ffprobe'): Binary {
  const envVar = kind === 'ffmpeg' ? 'HELM_FFMPEG_PATH' : 'HELM_FFPROBE_PATH';
  const candidates: string[] = [];
  const fromEnv = process.env[envVar];
  if (fromEnv) candidates.push(fromEnv);

  const bundled =
    kind === 'ffmpeg'
      ? optionalModulePath('ffmpeg-static', (m) => (m as { default?: string }).default ?? m)
      : optionalModulePath('ffprobe-static', (m) => (m as { path?: string }).path);
  if (bundled && existsSync(bundled)) candidates.push(bundled);

  candidates.push(kind);

  for (const candidate of candidates) {
    const major = versionOf(candidate);
    if (major !== null) return { path: candidate, majorVersion: major };
  }
  throw new VideoRenderError(
    `Could not find a working ${kind}. Install the ${kind === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static'} ` +
      `package, put ${kind} on PATH, or set ${envVar} to its full path.`,
  );
}

export function ffmpeg(): Binary {
  return (ffmpegBin ??= resolve('ffmpeg'));
}

export function ffprobe(): Binary {
  return (ffprobeBin ??= resolve('ffprobe'));
}

/** The constant-frame-rate flag under whichever ffmpeg we found. */
export function cfrFlags(): string[] {
  return ffmpeg().majorVersion >= 5 ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(bin: string, args: string[], label: string): Promise<RunResult> {
  return new Promise((resolve_, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => reject(new VideoRenderError(`${label}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve_({ stdout, stderr });
      else reject(new VideoRenderError(`${label} failed (exit ${code}):\n${tail(stderr)}`));
    });
  });
}

export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

export interface StreamInfo {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  duration_ts?: number;
  time_base?: string;
}

export interface ProbeResult {
  streams: StreamInfo[];
  format: { duration?: string; format_name?: string };
}

export async function probe(file: string, countFrames = false): Promise<ProbeResult> {
  const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json'];
  if (countFrames) args.push('-count_frames');
  args.push(file);
  const { stdout } = await run(ffprobe().path, args, `ffprobe ${file}`);
  const parsed = JSON.parse(stdout) as Partial<ProbeResult>;
  return { streams: parsed.streams ?? [], format: parsed.format ?? {} };
}

/**
 * Number of samples per channel in `file` after decoding to `sampleRate`.
 *
 * The samples are counted by decoding to raw PCM and measuring the byte stream,
 * rather than by reading a header field. Container metadata is rounded in some
 * formats and absent in others, and a narration length that is wrong by a few
 * milliseconds shifts every scene that follows it.
 */
export function countAudioSamples(file: string, sampleRate: number): Promise<number> {
  if (!existsSync(file)) {
    return Promise.reject(new VideoRenderError(`Audio file not found: ${file}`));
  }
  return new Promise((resolve_, reject) => {
    const child = spawn(
      ffmpeg().path,
      ['-v', 'error', '-i', file, '-map', 'a:0', '-ac', '1', '-ar', String(sampleRate),
       '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (bytes += chunk.length));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => reject(new VideoRenderError(`Could not decode ${file}: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new VideoRenderError(`Could not decode ${file} (ffmpeg exit ${code}):\n${tail(stderr)}`));
        return;
      }
      if (bytes === 0) {
        reject(new VideoRenderError(`${file} decoded to no audio at all — is there an audio stream in it?`));
        return;
      }
      resolve_(bytes / 2); // s16le is two bytes per sample
    });
  });
}

/** Length of an audio file in seconds, measured by counting decoded samples. */
export async function audioDurationSeconds(file: string, sampleRate: number): Promise<number> {
  return (await countAudioSamples(file, sampleRate)) / sampleRate;
}

/** Peak level in dBFS, or null when ffmpeg reported none. `-inf` for silence. */
export async function peakLevelDb(file: string): Promise<number | null> {
  const { stderr } = await run(
    ffmpeg().path,
    ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    `volumedetect ${file}`,
  );
  const match = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (!match) return null;
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}
