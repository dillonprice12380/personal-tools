import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useApi, type ListResponse } from '../lib/api';
import { Banner, Chip, ConfirmButton, Empty, Field, Modal, ProgressBar } from './ui';
import { formatDateTime } from '../lib/format';

export type VideoProject = {
  id: number;
  name: string;
  spec_json: string;
  spec: any;
  status: 'draft' | 'queued' | 'rendering' | 'ready' | 'failed';
  progress: number;
  output_file: string;
  output_url: string;
  captions_url: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  error: string;
  rendered_at: string | null;
  updated_at: string;
};

export type VideoAsset = {
  id: number;
  kind: 'audio' | 'image';
  filename: string;
  original_name: string;
  bytes: number;
  duration_seconds: number | null;
};

type LibraryItem = {
  id: number;
  name: string;
  output_url: string;
  captions_url: string;
  duration_seconds: number | null;
  width: number;
  height: number;
  exists: boolean;
};

type Plan = {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  cues: number;
  scenes: { id: string; startSeconds: number; endSeconds: number; frames: number; narrationSeconds: number; cues: number }[];
  warnings: string[];
};

const STATUS_TONE: Record<VideoProject['status'], 'good' | 'warning' | 'critical' | 'accent' | ''> = {
  ready: 'good',
  rendering: 'accent',
  queued: 'accent',
  failed: 'critical',
  draft: '',
};

const STARTER_SPEC = {
  preset: 'vertical',
  fps: 30,
  scenes: [
    {
      id: 'intro',
      narration: { path: 'upload-an-audio-file.wav', text: 'What is spoken here becomes the captions.' },
      title: 'Your title',
      body: 'A line of supporting copy.',
    },
  ],
};

function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const m = Math.floor(value / 60);
  const s = value % 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`;
}

function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/* ------------------------------------------------------------------ */
/* Composer: attach a finished render to a post                        */
/* ------------------------------------------------------------------ */

/**
 * Renders ready to attach, shown inside the composer.
 *
 * Attaching appends the render's URL to the post's media list, which is what
 * the publishers already consume — so a video needs no special path through
 * scheduling or publishing.
 */
export function VideoAttach({ onAttach }: { onAttach: (url: string) => void }) {
  const library = useApi<{ items: LibraryItem[]; publicUrlConfigured: boolean }>('/video-library');
  const items = library.data?.items ?? [];
  const [open, setOpen] = useState(false);

  if (library.loading) return null;
  if (!items.length) {
    return (
      <p className="small muted">
        No rendered videos yet. Make one on the <strong>Videos</strong> tab and it will show up here.
      </p>
    );
  }

  return (
    <div>
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide videos' : `Attach a video (${items.length})`}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {!library.data?.publicUrlConfigured && (
            <p className="small muted" style={{ marginTop: 0 }}>
              Instagram and TikTok fetch media themselves, so they can only post a video whose URL
              resolves on the public internet. Set <code>HELM_PUBLIC_URL</code> to the address Helm is
              reachable at, or attach a video only to the networks that take an upload or a link.
            </p>
          )}
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td className="muted small">
                      {item.width}×{item.height} · {seconds(item.duration_seconds)}
                    </td>
                    <td className="right">
                      {item.exists ? (
                        <button type="button" className="btn sm" onClick={() => onAttach(item.output_url)}>
                          Attach
                        </button>
                      ) : (
                        <span className="small neg">file is missing</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Videos tab                                                          */
/* ------------------------------------------------------------------ */

export function VideoTab() {
  const projects = useApi<ListResponse<VideoProject>>('/video-projects?limit=200');
  const assets = useApi<ListResponse<VideoAsset>>('/video-assets');
  const [editing, setEditing] = useState<VideoProject | 'new' | null>(null);
  const [error, setError] = useState('');

  const items = projects.data?.items ?? [];
  const busy = items.some((p) => p.status === 'queued' || p.status === 'rendering');

  // Progress lives in the database, written by the render process, so the only
  // way to follow it is to ask again. Polling stops when nothing is rendering.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void projects.reload(), 1500);
    return () => clearInterval(timer);
  }, [busy, projects.reload]);

  const create = async () => {
    setError('');
    try {
      const made = await api.post<VideoProject>('/video-projects', {
        name: 'Untitled video',
        spec_json: STARTER_SPEC,
      });
      await projects.reload();
      setEditing(made);
    } catch (err: any) {
      setError(err?.message ?? 'Could not create the project');
    }
  };

  const render = async (project: VideoProject) => {
    setError('');
    try {
      await api.post(`/video-projects/${project.id}/render`);
      void projects.reload();
    } catch (err: any) {
      setError(err?.message ?? 'Could not start the render');
    }
  };

  return (
    <>
      <Banner tone="error">{error || projects.error || ''}</Banner>

      <div className="row between" style={{ marginBottom: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>
          Narrated videos with burnt-in captions. Scene lengths come from the narration audio, and a
          finished render can be attached to any post from the composer.
        </p>
        <button className="btn primary" onClick={create}>New video</button>
      </div>

      {items.length === 0 ? (
        <Empty
          icon="▶"
          title="No videos yet"
          hint="Create one, upload narration audio, and describe the scenes."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Format</th>
                <th>Rendered</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((project) => (
                <tr key={project.id}>
                  <td>
                    <strong>{project.name}</strong>
                    {project.status === 'failed' && project.error && (
                      <div className="small neg" style={{ whiteSpace: 'pre-wrap', maxWidth: 460 }}>
                        {project.error.split('\n').slice(0, 3).join('\n')}
                      </div>
                    )}
                  </td>
                  <td>
                    <Chip tone={STATUS_TONE[project.status]}>{project.status}</Chip>
                    {(project.status === 'rendering' || project.status === 'queued') && (
                      <div style={{ minWidth: 120, marginTop: 4 }}>
                        <ProgressBar percent={Math.round(project.progress * 100)} />
                      </div>
                    )}
                  </td>
                  <td className="muted small">
                    {project.width ? `${project.width}×${project.height} · ${project.fps}fps` : '—'}
                    {project.duration_seconds ? ` · ${seconds(project.duration_seconds)}` : ''}
                  </td>
                  <td className="muted small">
                    {project.rendered_at ? formatDateTime(project.rendered_at) : '—'}
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      {project.status === 'ready' && project.output_url && (
                        <a className="btn sm" href={project.output_url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      )}
                      {project.status === 'rendering' || project.status === 'queued' ? (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            await api.post(`/video-projects/${project.id}/cancel`);
                            void projects.reload();
                          }}
                        >
                          Cancel
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => render(project)}>Render</button>
                      )}
                      <button className="btn sm" onClick={() => setEditing(project)}>Edit</button>
                      <ConfirmButton
                        onConfirm={async () => {
                          await api.del(`/video-projects/${project.id}`);
                          void projects.reload();
                        }}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AssetsPanel assets={assets.data?.items ?? []} onChanged={() => void assets.reload()} />

      {editing && (
        <ProjectEditor
          project={editing === 'new' ? null : editing}
          assets={assets.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void projects.reload();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

function AssetsPanel({ assets, onChanged }: { assets: VideoAsset[]; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState('');

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      for (const file of Array.from(files)) {
        // The body is the file itself; the API takes the name from the query.
        const res = await fetch(`/api/video-assets?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(JSON.parse(text || '{}')?.error ?? `Upload failed (${res.status})`);
        }
      }
      onChanged();
    } catch (err: any) {
      setError(err?.message ?? 'Upload failed');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div className="row between">
        <div className="stat-label">Narration and images</div>
        <label className="btn">
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            ref={input}
            type="file"
            multiple
            accept=".wav,.mp3,.m4a,.aac,.ogg,.opus,.flac,.png,.jpg,.jpeg,.webp"
            style={{ display: 'none' }}
            onChange={(e) => void upload(e.target.files)}
          />
        </label>
      </div>
      <Banner tone="error">{error}</Banner>
      {assets.length === 0 ? (
        <p className="small muted">
          Upload the narration audio your scenes refer to. Helm decodes each file on upload, so a
          file it cannot read is rejected here rather than failing a render later.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td>
                    <code>{asset.filename}</code>
                    <div className="small muted">{asset.original_name}</div>
                  </td>
                  <td className="muted small">
                    {asset.kind}
                    {asset.duration_seconds ? ` · ${seconds(asset.duration_seconds)}` : ''} · {bytes(asset.bytes)}
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button
                        className="btn sm"
                        onClick={() => {
                          void navigator.clipboard?.writeText(asset.filename);
                          setCopied(asset.filename);
                        }}
                      >
                        {copied === asset.filename ? 'Copied' : 'Copy name'}
                      </button>
                      <ConfirmButton
                        onConfirm={async () => {
                          await api.del(`/video-assets/${asset.id}`);
                          onChanged();
                        }}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function ProjectEditor({
  project,
  assets,
  onClose,
  onSaved,
}: {
  project: VideoProject | null;
  assets: VideoAsset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project?.name ?? 'Untitled video');
  const [specText, setSpecText] = useState(() =>
    JSON.stringify(project?.spec ?? STARTER_SPEC, null, 2)
  );
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [still, setStill] = useState<string>('');
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);

  // Object URLs for the preview are revoked so a long editing session does not
  // hold every frame it ever rendered in memory.
  useEffect(() => () => { if (still) URL.revokeObjectURL(still); }, [still]);

  const parsed = useMemo(() => {
    try {
      return { spec: JSON.parse(specText), error: '' };
    } catch (err: any) {
      return { spec: null, error: `The spec is not valid JSON: ${err?.message ?? ''}` };
    }
  }, [specText]);

  const projectId = project?.id;

  const check = useCallback(async () => {
    if (!projectId || !parsed.spec) return;
    setBusy(true);
    setError('');
    try {
      setPlan(await api.post<Plan>(`/video-projects/${projectId}/plan`, { spec: parsed.spec }));
    } catch (err: any) {
      setPlan(null);
      setError(err?.message ?? 'The spec could not be validated');
    } finally {
      setBusy(false);
    }
  }, [projectId, parsed.spec]);

  const preview = async () => {
    if (!projectId || !parsed.spec) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/video-projects/${projectId}/still`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: parsed.spec, frame }),
      });
      if (!res.ok) throw new Error(JSON.parse((await res.text()) || '{}')?.error ?? 'Preview failed');
      if (still) URL.revokeObjectURL(still);
      setStill(URL.createObjectURL(await res.blob()));
    } catch (err: any) {
      setError(err?.message ?? 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const save = async (thenRender: boolean) => {
    if (!parsed.spec) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const saved = project
        ? await api.patch<VideoProject>(`/video-projects/${project.id}`, { name, spec_json: parsed.spec })
        : await api.post<VideoProject>('/video-projects', { name, spec_json: parsed.spec });
      if (thenRender) await api.post(`/video-projects/${saved.id}/render`);
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={project ? 'Edit video' : 'New video'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !parsed.spec} onClick={() => void save(false)}>
            Save
          </button>
          <button className="btn primary" disabled={busy || !parsed.spec} onClick={() => void save(true)}>
            Save and render
          </button>
        </>
      }
    >
      <Banner tone="error">{error || parsed.error}</Banner>

      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field
        label="Spec"
        hint="Scenes, narration and on-screen copy. Narration paths are the uploaded filenames below; scene lengths come from the audio."
      >
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          spellCheck={false}
          style={{ minHeight: 260, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
        />
      </Field>

      {assets.length > 0 && (
        <p className="small muted">
          Uploaded: {assets.slice(0, 8).map((a) => <code key={a.id} style={{ marginRight: 8 }}>{a.filename}</code>)}
        </p>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy || !projectId || !parsed.spec} onClick={() => void check()}>
          Check
        </button>
        <Field label="Preview frame">
          <input
            type="number"
            min={0}
            value={frame}
            onChange={(e) => setFrame(Math.max(0, Number(e.target.value) || 0))}
            style={{ width: 110 }}
          />
        </Field>
        <button className="btn" disabled={busy || !projectId || !parsed.spec} onClick={() => void preview()}>
          Preview frame
        </button>
        {!projectId && <span className="small muted">Save the video first to check or preview it.</span>}
      </div>

      {plan && (
        <div style={{ marginTop: 12 }}>
          <div className="stat-label">
            {plan.width}×{plan.height} · {plan.fps} fps · {plan.frames} frames ·{' '}
            {seconds(plan.durationSeconds)} · {plan.cues} caption cues
          </div>
          {plan.warnings.map((w) => <Banner key={w} tone="error">{w}</Banner>)}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Scene</th><th>Starts</th><th>Ends</th><th>Frames</th><th>Narration</th><th>Cues</th></tr>
              </thead>
              <tbody>
                {plan.scenes.map((scene) => (
                  <tr key={scene.id}>
                    <td>{scene.id}</td>
                    <td className="muted small">{scene.startSeconds.toFixed(3)}s</td>
                    <td className="muted small">{scene.endSeconds.toFixed(3)}s</td>
                    <td className="muted small">{scene.frames}</td>
                    <td className="muted small">{scene.narrationSeconds.toFixed(3)}s</td>
                    <td className="muted small">{scene.cues}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Every piece of text fits its box at these sizes — that is checked here, so a render
            cannot fail on layout later.
          </p>
        </div>
      )}

      {still && (
        <div style={{ marginTop: 12 }}>
          <div className="stat-label">Frame {frame}</div>
          <img src={still} alt={`Frame ${frame}`} style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 8 }} />
        </div>
      )}
    </Modal>
  );
}
