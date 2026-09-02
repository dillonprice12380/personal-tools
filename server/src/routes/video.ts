import { Router, raw } from 'express';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import { config } from '../config.js';
import { all, get, logActivity, run } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, parseJson, toInt, wrap } from '../lib/http.js';
import {
  cancelRender,
  enqueueRender,
  planProject,
  renderStill,
  renderUrl,
} from '../services/video/projects.js';
import { audioDurationSeconds } from '../services/video/ffmpeg.js';
import { PRESETS, SUPPORTED_FPS } from '../services/video/spec.js';
import { VideoRenderError, VideoSpecError, type VideoSpecInput } from '../services/video/types.js';

export const videoRouter = Router();

/**
 * Extensions Helm will store, and what each is for. The extension is chosen
 * from this table rather than taken from the upload, so a file called
 * `x.wav.sh` cannot land on disk as a script.
 */
const ALLOWED_EXTENSIONS: Record<string, 'audio' | 'image'> = {
  '.wav': 'audio',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.flac': 'audio',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
};

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function slug(name: string): string {
  return (
    name
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'asset'
  );
}

/** Spec for a project, preferring one supplied in the request body. */
function specFor(id: number, body: any): VideoSpecInput {
  const project = get<{ spec_json: string }>('SELECT spec_json FROM video_projects WHERE id = ?', [id]);
  if (!project) throw notFound('Video project');
  if (body?.spec !== undefined) {
    if (typeof body.spec !== 'object' || body.spec === null) throw badRequest('spec must be a JSON object');
    return body.spec as VideoSpecInput;
  }
  return parseJson<VideoSpecInput>(project.spec_json, { scenes: [] });
}

/** Turn a spec or render failure into a 400 rather than a 500. */
function asHttpError(err: unknown): never {
  if (err instanceof VideoSpecError || err instanceof VideoRenderError) throw badRequest(err.message);
  throw err;
}

/* ------------------------------- catalogue ------------------------------ */

videoRouter.get(
  '/video-options',
  wrap((_req, res) => {
    res.json({
      presets: Object.entries(PRESETS).map(([id, size]) => ({ id, ...size })),
      fps: SUPPORTED_FPS,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      audioExtensions: Object.keys(ALLOWED_EXTENSIONS).filter((e) => ALLOWED_EXTENSIONS[e] === 'audio'),
      imageExtensions: Object.keys(ALLOWED_EXTENSIONS).filter((e) => ALLOWED_EXTENSIONS[e] === 'image'),
      /** Whether media URLs will resolve off this machine. */
      publicUrlConfigured: !!config.publicUrl,
    });
  })
);

/* --------------------------------- assets ------------------------------- */

videoRouter.get(
  '/video-assets',
  wrap((req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
    const items = kind
      ? all('SELECT * FROM video_assets WHERE kind = ? ORDER BY created_at DESC', [kind])
      : all('SELECT * FROM video_assets ORDER BY created_at DESC');
    res.json({ items });
  })
);

/**
 * Upload narration audio or an image.
 *
 * The body is the file itself rather than a multipart form: Helm has one user
 * and one field to send, so a raw body avoids a parser dependency entirely.
 */
videoRouter.post(
  '/video-assets',
  raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  wrap(async (req, res) => {
    const original = String(req.query.name ?? '').trim();
    if (!original) throw badRequest('A ?name= query parameter with the original filename is required');

    const extension = extname(original).toLowerCase();
    const kind = ALLOWED_EXTENSIONS[extension];
    if (!kind) {
      throw badRequest(
        `${extension || 'That file'} is not a supported upload. Use one of: ${Object.keys(ALLOWED_EXTENSIONS).join(', ')}`
      );
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('The request body was empty');

    mkdirSync(config.videoAssetsDir, { recursive: true });
    const filename = `${slug(original)}-${randomBytes(6).toString('hex')}${extension}`;
    const full = join(config.videoAssetsDir, filename);
    writeFileSync(full, body);

    // Decode audio now rather than at render time: a file ffmpeg cannot read is
    // far easier to understand as a failed upload than as a failed render.
    let durationSeconds: number | null = null;
    if (kind === 'audio') {
      try {
        durationSeconds = await audioDurationSeconds(full, 48000);
      } catch (err) {
        rmSync(full, { force: true });
        throw badRequest(
          `That file could not be decoded as audio: ${(err as Error).message.split('\n')[0]}`
        );
      }
    }

    const result = run(
      `INSERT INTO video_assets (kind, filename, original_name, mime, bytes, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [kind, filename, original.slice(0, 200), String(req.headers['content-type'] ?? ''), body.length, durationSeconds]
    );
    const row = get('SELECT * FROM video_assets WHERE id = ?', [result.lastInsertRowid]);
    logActivity('video_assets', Number(result.lastInsertRowid), 'create', original);
    res.status(201).json(row);
  })
);

videoRouter.delete(
  '/video-assets/:id',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const asset = get<{ id: number; filename: string; original_name: string }>(
      'SELECT * FROM video_assets WHERE id = ?',
      [id]
    );
    if (!asset) throw notFound('Asset');
    rmSync(join(config.videoAssetsDir, asset.filename), { force: true });
    run('DELETE FROM video_assets WHERE id = ?', [id]);
    logActivity('video_assets', id, 'delete', asset.original_name);
    res.status(204).end();
  })
);

/* -------------------------------- projects ------------------------------ */

videoRouter.use(
  '/video-projects',
  crud({
    table: 'video_projects',
    // Render state is listed so beforeWrite can reset it — crud drops any field
    // that is not a declared column. Client-supplied values are stripped there.
    columns: ['name', 'spec_json', 'status', 'progress', 'error', 'updated_at'],
    filters: ['status'],
    search: ['name'],
    orderBy: 'updated_at DESC',
    sortable: ['name', 'updated_at', 'created_at', 'status', 'id'],
    describe: (r) => String(r?.name ?? ''),
    hydrate: (row) => ({
      ...row,
      spec: parseJson<VideoSpecInput>(row.spec_json, { scenes: [] }),
      output_url: row.output_file ? renderUrl(row.output_file) : '',
      captions_url: row.captions_file ? renderUrl(row.captions_file) : '',
    }),
    beforeWrite: (data) => {
      // Render state belongs to the queue, not to whoever sent the request.
      for (const owned of ['status', 'progress', 'error']) delete data[owned];

      if (data.spec_json !== undefined) {
        if (typeof data.spec_json !== 'string') data.spec_json = JSON.stringify(data.spec_json);
        // Editing the spec invalidates whatever was rendered from the old one.
        // The file itself is left alone: its URL may already be attached to a
        // post, and status alone takes it out of the composer's library.
        data.status = 'draft';
        data.progress = 0;
        data.error = '';
      }
      data.updated_at = new Date().toISOString();
    },
    afterWrite: (row, action) => {
      if (action !== 'delete' || !row) return;
      // The renderer writes .srt and .vtt beside the video; all three go.
      const base = String(row.output_file || '').replace(/\.mp4$/, '');
      const files = new Set([row.output_file, row.captions_file, base && `${base}.srt`, base && `${base}.vtt`]);
      for (const file of files) {
        if (file) rmSync(join(config.videoRendersDir, String(file)), { force: true });
      }
    },
  })
);

/** Validate a spec and report the timeline it would produce. Renders nothing. */
videoRouter.post(
  '/video-projects/:id/plan',
  wrap(async (req, res) => {
    const spec = specFor(toInt(req.params.id), req.body);
    try {
      res.json(await planProject(spec));
    } catch (err) {
      asHttpError(err);
    }
  })
);

/** One frame as a PNG, for previewing layout without a full render. */
videoRouter.post(
  '/video-projects/:id/still',
  wrap(async (req, res) => {
    const spec = specFor(toInt(req.params.id), req.body);
    const frame = toInt(req.body?.frame, 0);
    try {
      const png = await renderStill(spec, Math.max(0, frame));
      res.type('image/png').send(png);
    } catch (err) {
      asHttpError(err);
    }
  })
);

videoRouter.post(
  '/video-projects/:id/render',
  wrap(async (req, res) => {
    const id = toInt(req.params.id);
    const project = get<{ id: number; status: string }>('SELECT * FROM video_projects WHERE id = ?', [id]);
    if (!project) throw notFound('Video project');
    if (project.status === 'rendering' || project.status === 'queued') {
      throw badRequest('That video is already rendering.');
    }
    // Fail here, with a useful message, rather than in a background process.
    try {
      await planProject(specFor(id, null));
    } catch (err) {
      asHttpError(err);
    }
    enqueueRender(id);
    res.json(get('SELECT * FROM video_projects WHERE id = ?', [id]));
  })
);

videoRouter.post(
  '/video-projects/:id/cancel',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM video_projects WHERE id = ?', [id])) throw notFound('Video project');
    const stopped = cancelRender(id);
    res.json({ stopped, project: get('SELECT * FROM video_projects WHERE id = ?', [id]) });
  })
);

/** Renders ready to attach to a post, for the composer. */
videoRouter.get(
  '/video-library',
  wrap((req, res) => {
    const origin = config.publicUrl || `${req.protocol}://${req.get('host') ?? ''}`;
    res.json({
      items: all<any>(
        `SELECT id, name, output_file, captions_file, duration_seconds, width, height, fps, rendered_at
           FROM video_projects
          WHERE status = 'ready' AND output_file <> ''
          ORDER BY rendered_at DESC`
      ).map((row) => ({
        ...row,
        output_url: renderUrl(row.output_file, origin),
        captions_url: row.captions_file ? renderUrl(row.captions_file, origin) : '',
        exists: existsSync(join(config.videoRendersDir, row.output_file)),
      })),
      publicUrlConfigured: !!config.publicUrl,
    });
  })
);
