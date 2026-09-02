/**
 * Video projects: turning a stored spec into a rendered file.
 *
 * Renders run in a child process (see worker.ts) one at a time. Two reasons
 * for the queue rather than unbounded parallelism: a render already saturates a
 * core, and Helm is a single-user app where two videos at once would only make
 * both of them slower.
 *
 * Every path in a stored spec is confined to the uploads directory. A spec
 * arrives over HTTP, so it is not trusted to name files on the disk.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { all, get, logActivity, run } from '../../db.js';
import { parseJson } from '../../lib/http.js';
import { normaliseSpec } from './spec.js';
import { buildTimeline } from './timeline.js';
import { FrameComposer } from './frames.js';
import { audioDurationSeconds } from './ffmpeg.js';
import type { VideoSpec, VideoSpecInput } from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface ProjectRow {
  id: number;
  name: string;
  spec_json: string;
  status: string;
  progress: number;
  output_file: string;
  captions_file: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  error: string;
  rendered_at: string | null;
}

/**
 * Validate a stored spec against the uploads directory.
 *
 * `forceOutput` is a throwaway path: callers that only want validation never
 * write anything, and the render path overrides it with the real destination.
 */
export function normaliseProjectSpec(specInput: VideoSpecInput, output = join(config.videoRendersDir, 'preview.mp4')): VideoSpec {
  return normaliseSpec(specInput, config.videoAssetsDir, {
    allowedRoot: config.videoAssetsDir,
    forceOutput: output,
  });
}

export interface PlannedScene {
  id: string;
  startSeconds: number;
  endSeconds: number;
  frames: number;
  narrationSeconds: number;
  cues: number;
}

export interface Plan {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  scenes: PlannedScene[];
  cues: number;
  warnings: string[];
}

/**
 * Validate a spec and work out its timeline without rendering.
 *
 * Constructing the composer is the part that proves every piece of text fits
 * its box, so a spec that passes this cannot fail layout during the render.
 */
export async function planProject(specInput: VideoSpecInput): Promise<Plan> {
  const spec = normaliseProjectSpec(specInput);
  const narrationSeconds = await Promise.all(
    spec.scenes.map((scene) =>
      scene.narration ? audioDurationSeconds(scene.narration.path, spec.audio.sampleRate) : null,
    ),
  );
  const timeline = buildTimeline(spec, narrationSeconds);
  const composer = new FrameComposer(spec, timeline);
  const missing = composer.missingGlyphs();

  return {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    frames: timeline.totalFrames,
    durationSeconds: timeline.totalFrames / spec.fps,
    cues: timeline.cues.length,
    scenes: timeline.scenes.map((timing) => ({
      id: timing.id,
      startSeconds: timing.startFrame / spec.fps,
      endSeconds: timing.endFrame / spec.fps,
      frames: timing.frames,
      narrationSeconds: timing.narrationFrames / spec.fps,
      cues: timeline.cues.filter((c) => c.sceneIndex === timing.index).length,
    })),
    warnings: missing.length
      ? [`The font cannot draw ${missing.map((c) => JSON.stringify(c)).join(', ')}; they would render as blank boxes.`]
      : [],
  };
}

/** Rasterise a single frame, for a layout preview. */
export async function renderStill(specInput: VideoSpecInput, frame: number): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  const spec = normaliseProjectSpec(specInput);
  const narrationSeconds = await Promise.all(
    spec.scenes.map((scene) =>
      scene.narration ? audioDurationSeconds(scene.narration.path, spec.audio.sampleRate) : null,
    ),
  );
  const timeline = buildTimeline(spec, narrationSeconds);
  const clamped = Math.max(0, Math.min(frame, timeline.totalFrames - 1));
  const composer = new FrameComposer(spec, timeline);
  return Buffer.from(new Resvg(composer.svgForFrame(clamped), { font: { loadSystemFonts: false } }).render().asPng());
}

/* ----------------------------- the queue ----------------------------- */

const queue: number[] = [];
let active: { projectId: number; child: ChildProcess; workDir: string } | null = null;

/** Where the compiled worker lives, next to whichever form of this module ran. */
function workerEntry(): { command: string; args: string[] } {
  const bundled = join(moduleDir, 'video-worker.js');
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };

  // Development: this module is the TypeScript source, so tsx loads the sibling.
  const source = join(moduleDir, 'worker.ts');
  if (existsSync(source)) return { command: process.execPath, args: ['--import', 'tsx', source] };

  throw new Error(
    'Could not find the video render worker. Run `npm run build` in the server workspace, ' +
      'which produces dist/video-worker.js.',
  );
}

function setStatus(id: number, fields: Record<string, unknown>): void {
  const cols = Object.keys(fields);
  run(
    `UPDATE video_projects SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    [...cols.map((c) => fields[c]), id],
  );
}

/**
 * Mark renders that were in flight when the process died.
 *
 * Without this a crash leaves a row saying "rendering" for ever, and the UI
 * waits on a child process that no longer exists.
 */
export function resetInterruptedRenders(): number {
  const stuck = all<{ id: number }>("SELECT id FROM video_projects WHERE status IN ('queued', 'rendering')");
  for (const row of stuck) {
    setStatus(row.id, {
      status: 'failed',
      progress: 0,
      error: 'Helm restarted while this video was rendering. Start the render again.',
    });
  }
  return stuck.length;
}

export function enqueueRender(projectId: number): void {
  if (active?.projectId === projectId || queue.includes(projectId)) return;
  setStatus(projectId, { status: 'queued', progress: 0, error: '' });
  queue.push(projectId);
  pump();
}

export function cancelRender(projectId: number): boolean {
  const queued = queue.indexOf(projectId);
  if (queued !== -1) {
    queue.splice(queued, 1);
    setStatus(projectId, { status: 'draft', progress: 0, error: '' });
    return true;
  }
  if (active?.projectId === projectId) {
    active.child.kill('SIGTERM');
    return true;
  }
  return false;
}

function pump(): void {
  if (active || queue.length === 0) return;
  const projectId = queue.shift() as number;
  const project = get<ProjectRow>('SELECT * FROM video_projects WHERE id = ?', [projectId]);
  if (!project) {
    pump();
    return;
  }

  let entry: { command: string; args: string[] };
  try {
    entry = workerEntry();
  } catch (err) {
    setStatus(projectId, { status: 'failed', error: (err as Error).message });
    pump();
    return;
  }

  // A fresh unguessable name per render: the file is served without a session,
  // and the previous render's URL may already be attached to a published post.
  const token = randomBytes(12).toString('hex');
  const outputName = `${projectId}-${token}.mp4`;
  mkdirSync(config.videoRendersDir, { recursive: true });
  const output = join(config.videoRendersDir, outputName);

  const workDir = mkdtempSync(join(tmpdir(), 'helm-video-job-'));
  const jobFile = join(workDir, 'job.json');
  writeFileSync(
    jobFile,
    JSON.stringify({
      spec: parseJson<VideoSpecInput>(project.spec_json, { scenes: [] }),
      baseDir: config.videoAssetsDir,
      allowedRoot: config.videoAssetsDir,
      output,
    }),
    'utf8',
  );

  setStatus(projectId, { status: 'rendering', progress: 0, error: '' });
  const child = spawn(entry.command, [...entry.args, jobFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  active = { projectId, child, workDir };

  let stdout = '';
  let stderr = '';
  let done: Record<string, any> | null = null;
  let failure = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    // Whole lines only; a partial line stays in the buffer for the next chunk.
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === 'progress' && message.total > 0) {
        setStatus(projectId, { progress: message.done / message.total });
      } else if (message.type === 'done') {
        done = message;
      } else if (message.type === 'error') {
        failure = String(message.message ?? 'Render failed');
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const finish = (code: number | null, signal: string | null) => {
    rmSync(workDir, { recursive: true, force: true });
    active = null;

    if (signal) {
      rmSync(output, { force: true });
      setStatus(projectId, { status: 'draft', progress: 0, error: '' });
      logActivity('video_projects', projectId, 'render_cancelled', project.name);
    } else if (done) {
      const srtName = outputName.replace(/\.mp4$/, '.srt');
      setStatus(projectId, {
        status: 'ready',
        progress: 1,
        error: '',
        output_file: outputName,
        captions_file: existsSync(join(config.videoRendersDir, srtName)) ? srtName : '',
        duration_seconds: done.durationSeconds ?? null,
        width: done.width ?? null,
        height: done.height ?? null,
        fps: done.fps ?? null,
        frames: done.frames ?? null,
        rendered_at: new Date().toISOString(),
      });
      logActivity('video_projects', projectId, 'render_complete', project.name);
    } else {
      rmSync(output, { force: true });
      const message =
        failure ||
        stderr.trim().split('\n').slice(-5).join('\n') ||
        `The render worker exited with code ${code} without reporting why.`;
      setStatus(projectId, { status: 'failed', progress: 0, error: message.slice(0, 2000) });
      logActivity('video_projects', projectId, 'render_failed', project.name);
    }
    pump();
  };

  child.on('error', (err) => {
    failure = `Could not start the render worker: ${err.message}`;
    finish(1, null);
  });
  child.on('close', finish);
}

/** Public URL for a rendered file, absolute when HELM_PUBLIC_URL is set. */
export function renderUrl(filename: string, origin?: string): string {
  const path = `/media/video/${filename}`;
  const base = config.publicUrl || origin || '';
  return base ? `${base}${path}` : path;
}
