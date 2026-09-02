import React, { useMemo, useState } from 'react';
import { api, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, Stat, Tabs } from '../components/ui';
import { formatDate, formatDateTime, num } from '../lib/format';
import { VideoAttach, VideoTab } from '../components/video';

type Account = {
  id: number;
  platform: string;
  handle: string;
  display_name: string;
  enabled: number;
  credential_id: number | null;
  provider_label: string;
  char_limit: number;
  has_credential: boolean;
};

type Target = {
  id: number;
  account_id: number;
  platform: string;
  handle: string;
  status: 'pending' | 'published' | 'failed' | 'manual_required';
  remote_url: string;
  error: string;
};

type Post = {
  id: number;
  body: string;
  link: string;
  media: string[];
  campaign: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  targets: Target[];
};

type Provider = { id: string; label: string; charLimit: number; credentialFields: string[] };

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | 'accent' | ''> = {
  published: 'good',
  scheduled: 'accent',
  partial: 'warning',
  failed: 'critical',
  draft: '',
};

export function SocialPage() {
  const [tab, setTab] = useState<'queue' | 'calendar' | 'videos' | 'accounts'>('queue');
  const [connectNotice, setConnectNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('connected')) return { tone: 'ok', text: `${params.get('connected')} connected.` };
      if (params.get('connect_error')) return { tone: 'error', text: params.get('connect_error')! };
      return null;
    }
  );
  const [composing, setComposing] = useState<Post | 'new' | null>(null);

  const posts = useApi<ListResponse<Post>>('/social-posts?limit=200');
  const accounts = useApi<ListResponse<Account>>('/social-accounts');
  const providers = useApi<{ items: Provider[] }>('/social-providers');

  const items = posts.data?.items ?? [];
  const needsAttention = items.filter((p) =>
    p.targets.some((t) => t.status === 'failed' || t.status === 'manual_required')
  );

  const reload = () => {
    void posts.reload();
    void accounts.reload();
  };

  return (
    <>
      <header className="topbar">
        <h1>Social</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setComposing('new')}>
          + Compose
        </button>
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        {connectNotice && (
          <div className={`banner ${connectNotice.tone}`}>
            <div className="row">
              <span style={{ flex: 1 }}>{connectNotice.text}</span>
              <button
                className="btn sm ghost"
                onClick={() => {
                  setConnectNotice(null);
                  window.history.replaceState({}, '', '/social');
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        <div className="grid cols-4">
          <Card><Stat label="Scheduled" value={num(items.filter((p) => p.status === 'scheduled').length)} /></Card>
          <Card><Stat label="Drafts" value={num(items.filter((p) => p.status === 'draft').length)} /></Card>
          <Card><Stat label="Published" value={num(items.filter((p) => p.status === 'published').length)} /></Card>
          <Card>
            <Stat
              label="Needs attention"
              value={<span className={needsAttention.length ? 'neg' : ''}>{num(needsAttention.length)}</span>}
            />
          </Card>
        </div>

        <Tabs
          tabs={[
            { id: 'queue', label: 'Queue', count: items.length },
            { id: 'calendar', label: 'Calendar' },
            { id: 'videos', label: 'Videos' },
            { id: 'accounts', label: 'Accounts', count: accounts.data?.items.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {posts.error && <Banner tone="error">{posts.error}</Banner>}

        {tab === 'queue' && (
          <PostList posts={items} onEdit={(p) => setComposing(p)} onChanged={reload} />
        )}

        {tab === 'calendar' && <CalendarView posts={items} onEdit={(p) => setComposing(p)} />}

        {tab === 'videos' && <VideoTab />}

        {tab === 'accounts' && (
          <AccountsTab
            accounts={accounts.data?.items ?? []}
            providers={providers.data?.items ?? []}
            onChanged={reload}
          />
        )}
      </div>

      {composing && (
        <Composer
          post={composing === 'new' ? null : composing}
          accounts={accounts.data?.items ?? []}
          onClose={() => setComposing(null)}
          onSaved={() => {
            setComposing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function TargetChip({ target, onChanged }: { target: Target; onChanged: () => void }) {
  if (target.status === 'published') {
    return (
      <Chip tone="good">
        {target.platform}
        {target.remote_url && (
          <a href={target.remote_url} target="_blank" rel="noreferrer noopener" style={{ marginLeft: 4 }}>
            ↗
          </a>
        )}
      </Chip>
    );
  }
  if (target.status === 'failed') {
    return <Chip tone="critical" >{target.platform}: {target.error.slice(0, 40)}</Chip>;
  }
  if (target.status === 'manual_required') {
    return (
      <Chip tone="warning">
        {target.platform} — post by hand
        <button
          className="btn ghost sm"
          style={{ padding: '0 4px' }}
          onClick={async () => {
            await api.post(`/social-post-targets/${target.id}/mark-published`);
            onChanged();
          }}
        >
          mark done
        </button>
      </Chip>
    );
  }
  return <Chip>{target.platform}</Chip>;
}

function PostList({
  posts,
  onEdit,
  onChanged,
}: {
  posts: Post[];
  onEdit: (post: Post) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  if (!posts.length) {
    return (
      <Card>
        <Empty icon="◇" title="No posts yet" hint="Compose one and schedule it across every connected account." />
      </Card>
    );
  }

  return (
    <div className="stack">
      {posts.map((post) => (
        <Card key={post.id}>
          <div className="row between" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap" style={{ marginBottom: 6 }}>
                <Chip tone={STATUS_TONE[post.status] ?? ''}>{post.status}</Chip>
                {post.scheduled_at && <span className="small muted">{formatDateTime(post.scheduled_at)}</span>}
                {post.campaign && <Chip>{post.campaign}</Chip>}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{post.body}</div>
              {post.link && (
                <a className="small" href={post.link} target="_blank" rel="noreferrer noopener">
                  {post.link}
                </a>
              )}
              <div className="row wrap" style={{ marginTop: 8 }}>
                {post.targets.map((t) => (
                  <TargetChip key={t.id} target={t} onChanged={onChanged} />
                ))}
              </div>
            </div>
            <div className="stack" style={{ gap: 6, flex: 'none' }}>
              <button className="btn sm" onClick={() => onEdit(post)}>Edit</button>
              <button
                className="btn sm primary"
                disabled={busy === post.id || !post.targets.length}
                onClick={async () => {
                  setBusy(post.id);
                  try {
                    await api.post(`/social-posts/${post.id}/publish`, { retry: true });
                    onChanged();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === post.id ? 'Sending…' : post.status === 'failed' ? 'Retry' : 'Publish now'}
              </button>
              <ConfirmButton
                onConfirm={async () => {
                  await api.del(`/social-posts/${post.id}`);
                  onChanged();
                }}
              >
                Delete
              </ConfirmButton>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Month grid of scheduled posts - the view that makes gaps in the plan obvious. */
function CalendarView({ posts, onEdit }: { posts: Post[]; onEdit: (post: Post) => void }) {
  const [monthOffset, setMonthOffset] = useState(0);

  const { label, days } = useMemo(() => {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const year = base.getFullYear();
    const month = base.getMonth();
    const first = new Date(year, month, 1);
    const startPad = (first.getDay() + 6) % 7; // Monday-first
    const total = new Date(year, month + 1, 0).getDate();

    const cells: Array<{ date: string | null; posts: Post[] }> = [];
    for (let i = 0; i < startPad; i += 1) cells.push({ date: null, posts: [] });
    for (let d = 1; d <= total; d += 1) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({
        date,
        posts: posts.filter((p) => (p.scheduled_at ?? '').slice(0, 10) === date),
      });
    }
    return {
      label: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(base),
      days: cells,
    };
  }, [posts, monthOffset]);

  return (
    <Card
      title={label}
      actions={
        <div className="row">
          <button className="btn sm" onClick={() => setMonthOffset((m) => m - 1)}>←</button>
          <button className="btn sm" onClick={() => setMonthOffset(0)}>Today</button>
          <button className="btn sm" onClick={() => setMonthOffset((m) => m + 1)}>→</button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="small muted" style={{ textAlign: 'center', paddingBottom: 4 }}>
            {d}
          </div>
        ))}
        {days.map((cell, i) => (
          <div
            key={i}
            style={{
              minHeight: 78,
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: 5,
              background: cell.date ? 'var(--surface)' : 'transparent',
              opacity: cell.date ? 1 : 0.3,
            }}
          >
            {cell.date && (
              <>
                <div className="small muted">{Number(cell.date.slice(8))}</div>
                {cell.posts.map((post) => (
                  <button
                    key={post.id}
                    onClick={() => onEdit(post)}
                    className="truncate"
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      fontSize: 11,
                      marginTop: 3,
                      padding: '2px 4px',
                      borderRadius: 4,
                      border: 'none',
                      cursor: 'pointer',
                      background: post.status === 'published' ? 'var(--surface-sunken)' : 'var(--accent-wash)',
                      color: post.status === 'published' ? 'var(--text-2)' : 'var(--accent-ink)',
                    }}
                  >
                    {post.body.slice(0, 40)}
                  </button>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Composer({
  post,
  accounts,
  onClose,
  onSaved,
}: {
  post: Post | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState(post?.body ?? '');
  const [link, setLink] = useState(post?.link ?? '');
  const [campaign, setCampaign] = useState(post?.campaign ?? '');
  const [scheduledAt, setScheduledAt] = useState(
    post?.scheduled_at ? post.scheduled_at.replace(' ', 'T').slice(0, 16) : ''
  );
  const [mediaText, setMediaText] = useState((post?.media ?? []).join('\n'));
  const [selected, setSelected] = useState<number[]>(post?.targets.map((t) => t.account_id) ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const tightest = accounts
    .filter((a) => selected.includes(a.id))
    .reduce((min, a) => Math.min(min, a.char_limit), Infinity);
  const overBy = Number.isFinite(tightest) ? body.length - tightest : 0;

  const save = async (publishNow: boolean) => {
    setBusy(true);
    setError('');
    try {
      const payload = {
        body,
        link,
        campaign,
        media_json: mediaText
          .split(/[\n,]/)
          .map((m: string) => m.trim())
          .filter(Boolean),
        scheduled_at: scheduledAt ? scheduledAt.replace('T', ' ') : null,
        status: scheduledAt ? 'scheduled' : 'draft',
        account_ids: selected,
      };
      const saved = post
        ? await api.patch<Post>(`/social-posts/${post.id}`, payload)
        : await api.post<Post>('/social-posts', payload);
      if (publishNow) await api.post(`/social-posts/${saved.id}/publish`, { retry: true });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={post ? 'Edit post' : 'Compose'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy} onClick={() => save(false)}>
            {scheduledAt ? 'Schedule' : 'Save draft'}
          </button>
          <button className="btn primary" disabled={busy || !selected.length} onClick={() => save(true)}>
            Publish now
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>

      <Field label="Post">
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ minHeight: 130 }}
          placeholder="What are you sharing?"
        />
      </Field>
      <div className="row between small">
        <span className="muted">{body.length} characters</span>
        {Number.isFinite(tightest) && (
          <span className={overBy > 0 ? 'neg' : 'muted'}>
            {overBy > 0 ? `${overBy} over the ${tightest} limit` : `${tightest - body.length} left`}
          </span>
        )}
      </div>

      <div className="field-row">
        <Field label="Link">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Campaign">
          <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="e.g. launch-week" />
        </Field>
      </div>

      <Field
        label="Media URLs"
        hint="One per line. Instagram and TikTok can only post media hosted at a public https:// URL - they cannot take a local file."
      >
        <textarea
          value={mediaText}
          onChange={(e) => setMediaText(e.target.value)}
          placeholder="https://example.com/image.jpg"
          style={{ minHeight: 60 }}
        />
      </Field>

      <VideoAttach
        onAttach={(url) =>
          setMediaText((current) => {
            const lines = current.split('\n').map((l) => l.trim()).filter(Boolean);
            // Attaching the same render twice would post it twice.
            if (lines.includes(url)) return current;
            return [...lines, url].join('\n');
          })
        }
      />

      <Field label="Schedule for" hint="Leave empty to keep it as a draft">
        <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
      </Field>

      <div>
        <div className="stat-label" style={{ marginBottom: 6 }}>Post to</div>
        {accounts.length ? (
          <div className="row wrap">
            {accounts.map((account) => {
              const on = selected.includes(account.id);
              return (
                <button
                  key={account.id}
                  className={`btn sm ${on ? 'primary' : ''}`}
                  onClick={() =>
                    setSelected((prev) =>
                      on ? prev.filter((id) => id !== account.id) : [...prev, account.id]
                    )
                  }
                >
                  {account.provider_label} {account.handle}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="small muted">Add an account on the Accounts tab first.</p>
        )}
      </div>
    </Modal>
  );
}

function AccountsTab({
  accounts,
  providers,
  onChanged,
}: {
  accounts: Account[];
  providers: Provider[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Connected accounts"
      actions={
        <div className="row">
          <a className="btn sm" href="/settings">Connect LinkedIn / Meta / TikTok</a>
          <button className="btn sm primary" onClick={() => setAdding(true)}>+ Add account</button>
        </div>
      }
    >
      {accounts.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Handle</th>
                <th>Credential</th>
                <th className="right">Limit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.provider_label}</td>
                  <td>{a.handle || a.display_name || '—'}</td>
                  <td>
                    {a.platform === 'manual' ? (
                      <Chip>not needed</Chip>
                    ) : a.has_credential ? (
                      <Chip tone="good">stored</Chip>
                    ) : (
                      <Chip tone="warning">missing</Chip>
                    )}
                  </td>
                  <td className="right">{a.char_limit}</td>
                  <td className="right">
                    <ConfirmButton
                      onConfirm={async () => {
                        await api.del(`/social-accounts/${a.id}`);
                        onChanged();
                      }}
                    >
                      Remove
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon="◇"
          title="No accounts connected"
          hint="Add X, Mastodon, Bluesky, Discord, Telegram or a webhook here. LinkedIn, Facebook, Instagram and TikTok connect from Settings → Social network apps."
        />
      )}

      {adding && (
        <AccountForm providers={providers} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />
      )}
    </Card>
  );
}

function AccountForm({
  providers,
  onClose,
  onSaved,
}: {
  providers: Provider[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [platform, setPlatform] = useState(providers[0]?.id ?? 'mastodon');
  const [handle, setHandle] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const provider = providers.find((p) => p.id === platform);

  const save = async () => {
    try {
      let credentialId: number | null = null;
      if (provider?.credentialFields.length) {
        const created = await api.post<{ id: number }>('/settings/credentials', {
          service: platform,
          label: handle,
          data: creds,
        });
        credentialId = created.id;
      }
      await api.post('/social-accounts', { platform, handle, credential_id: credentialId });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save');
    }
  };

  return (
    <Modal
      title="Add account"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <Field label="Platform">
        <select
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value);
            setCreds({});
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Handle / name">
        <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@you" />
      </Field>

      {provider?.credentialFields.map((field) => (
        <Field key={field} label={field.replace(/_/g, ' ')}>
          <input
            type={field.includes('password') || field.includes('token') || field.includes('key') ? 'password' : 'text'}
            value={creds[field] ?? ''}
            onChange={(e) => setCreds({ ...creds, [field]: e.target.value })}
          />
        </Field>
      ))}

      <p className="small muted">
        Credentials are encrypted with AES-256-GCM before they touch the database, and are never
        returned by the API.
      </p>
    </Modal>
  );
}
