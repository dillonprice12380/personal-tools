/**
 * Render worker.
 *
 * Runs as a child process, one render per invocation. It exists because
 * rasterising a frame is synchronous CPU work: doing it in the API process
 * would freeze every other request for the length of a render, which for a
 * two-minute video is two minutes of a dead server.
 *
 * It speaks JSON lines on stdout so the parent can follow progress without
 * scraping human-readable output:
 *
 *   {"type":"progress","done":120,"total":535}
 *   {"type":"done","frames":535,"durationSeconds":17.83, ...}
 *   {"type":"error","message":"..."}
 */
import { readFileSync } from 'node:fs';
import { normaliseSpec } from './spec.js';
import { renderVideo } from './render.js';
import type { VideoSpecInput } from './types.js';

export interface RenderJob {
  spec: VideoSpecInput;
  /** Relative paths in the spec resolve against this. */
  baseDir: string;
  /** Every path in the spec must resolve inside this directory. */
  allowedRoot: string;
  /** Where to write the MP4; the spec's own `output` is ignored. */
  output: string;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<number> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    emit({ type: 'error', message: 'No job file was given to the render worker.' });
    return 2;
  }

  try {
    const job = JSON.parse(readFileSync(jobPath, 'utf8')) as RenderJob;
    const spec = normaliseSpec(job.spec, job.baseDir, {
      allowedRoot: job.allowedRoot,
      forceOutput: job.output,
    });

    // One line per whole percent: enough to drive a progress bar, few enough
    // that the pipe never becomes the bottleneck.
    let lastPercent = -1;
    const result = await renderVideo(spec, {
      fullVerify: true,
      onProgress: (done, total) => {
        const percent = Math.floor((done / total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          emit({ type: 'progress', done, total });
        }
      },
    });

    emit({
      type: 'done',
      output: result.output,
      srtPath: result.srtPath,
      frames: result.timeline.totalFrames,
      durationSeconds: result.durationSeconds,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      checks: result.verification.checks,
    });
    return 0;
  } catch (err) {
    emit({ type: 'error', message: (err as Error)?.message ?? String(err) });
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
