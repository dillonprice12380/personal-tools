import React, { useMemo, useState } from 'react';
import { api, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, ProgressBar, Stat, Tabs } from '../components/ui';
import { RankedBars } from '../components/charts';
import { formatDate, minutesToHours, money, num, relativeDay } from '../lib/format';

type Rung = { value: number; label: string; hint: string };

type Occupation = {
  id: number;
  code: string;
  title: string;
  description: string;
  source: string;
  skill_count: number;
};

type GapItem = {
  skill_id: number;
  code: string;
  name: string;
  category: string;
  importance: number;
  required_level: number;
  current_level: number;
  gap: number;
  surplus: number;
  priority: number;
  status: 'met' | 'close' | 'gap' | 'critical';
  unassessed: boolean;
  required_label: string;
  current_label: string;
};

type GapReport = {
  occupation: Occupation;
  summary: {
    readiness: number | null;
    requirements: number;
    assessed: number;
    met: number;
    gaps: number;
    critical: number;
    total_gap_minutes: number;
  };
  items: GapItem[];
};

type ProfileRow = {
  skill_id: number;
  code: string;
  name: string;
  category: string;
  current_level: number;
  assessed_on: string | null;
  importance: number | null;
  required_level: number | null;
};

type Resource = {
  id: number;
  skill_id: number | null;
  provider: string;
  title: string;
  url: string;
  instructor: string;
  headline: string;
  price_cents: number;
  currency: string;
  rating: number;
  reviews: number;
  students: number;
  duration_minutes: number;
  level: string;
  hidden: number;
  go_url: string;
  affiliate_network: string;
  clicks: number;
  link_ok: boolean | null;
};

type PlanItem = {
  id: number;
  skill_id: number;
  skill_name: string;
  resource_id: number | null;
  resource_title: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'skipped';
  from_level: number;
  target_level: number;
  importance: number;
  estimate_minutes: number;
  due_date: string | null;
  task_id: number | null;
  task_status: string | null;
  go_url: string | null;
};

type Plan = {
  id: number;
  name: string;
  status: string;
  occupation_id: number | null;
  occupation_title: string;
  weekly_minutes: number;
  start_date: string;
  target_date: string | null;
  project_id: number | null;
  items: PlanItem[];
  progress: { done: number; total: number; percent: number; minutes_done: number; minutes_total: number };
};

const STATUS_TONE: Record<GapItem['status'], '' | 'good' | 'warning' | 'serious' | 'critical'> = {
  met: 'good',
  close: 'warning',
  gap: 'serious',
  critical: 'critical',
};

export function SkillsPage() {
  const [tab, setTab] = useState<'gap' | 'assess' | 'plan' | 'courses' | 'affiliate'>('gap');
  const occupations = useApi<ListResponse<Occupation>>('/occupations?archived=0');
  const [targetId, setTargetId] = useState<number | null>(null);

  const roles = occupations.data?.items ?? [];
  const target = targetId ?? roles[0]?.id ?? null;

  const seed = async () => {
    await api.post('/skills-seed');
    void occupations.reload();
  };

  return (
    <>
      <header className="topbar">
        <h1>Skills</h1>
        <span className="spacer" />
        {roles.length > 0 && (
          <select
            value={target ?? ''}
            onChange={(e) => setTargetId(Number(e.target.value))}
            aria-label="Target role"
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.title}
              </option>
            ))}
          </select>
        )}
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        {!occupations.loading && roles.length === 0 ? (
          <Card>
            <Empty
              icon="◐"
              title="No skills database loaded yet"
              hint={
                <>
                  Load Helm's starter taxonomy to get going, or import the full O*NET database
                  with <code>npm run skills:import -- --dir ./db_30_0_text</code> for
                  authoritative ratings across roughly a thousand occupations.
                </>
              }
            />
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={seed}>
                Load starter taxonomy
              </button>
            </div>
          </Card>
        ) : (
          <>
            <Tabs
              tabs={[
                { id: 'gap', label: 'Gap analysis' },
                { id: 'assess', label: 'Self-assessment' },
                { id: 'plan', label: 'Plan' },
                { id: 'courses', label: 'Courses' },
                { id: 'affiliate', label: 'Affiliate' },
              ]}
              active={tab}
              onChange={setTab}
            />
            {tab === 'gap' && <GapTab occupationId={target} />}
            {tab === 'assess' && <AssessTab occupationId={target} />}
            {tab === 'plan' && <PlanTab occupationId={target} />}
            {tab === 'courses' && <CoursesTab />}
            {tab === 'affiliate' && <AffiliateTab />}
          </>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------- gap ----

function GapTab({ occupationId }: { occupationId: number | null }) {
  const report = useApi<GapReport>(occupationId ? `/skills-gap?occupation_id=${occupationId}` : null, [
    occupationId,
  ]);

  if (!occupationId) return <Card><Empty icon="◐" title="Pick a target role" /></Card>;
  if (report.loading && !report.data) return <div className="muted">Analysing…</div>;
  if (report.error) return <Banner tone="error">{report.error}</Banner>;
  if (!report.data) return null;

  const { summary, items } = report.data;
  const outstanding = items.filter((i) => i.gap > 0);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Card>
          <Stat
            label="Role readiness"
            value={summary.readiness === null ? '—' : `${summary.readiness}%`}
            sub={
              summary.readiness === null
                ? 'No requirements loaded'
                : 'Importance-weighted coverage'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Skills assessed"
            value={`${summary.assessed}/${summary.requirements}`}
            sub={
              summary.assessed < summary.requirements
                ? `${summary.requirements - summary.assessed} never rated`
                : 'All rated'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Gaps"
            value={num(summary.gaps)}
            sub={summary.critical ? `${summary.critical} critical` : 'None critical'}
          />
        </Card>
        <Card>
          <Stat
            label="Est. study time"
            value={minutesToHours(summary.total_gap_minutes)}
            sub="To close every gap"
          />
        </Card>
      </div>

      {summary.assessed === 0 && (
        <Banner>
          Nothing has been self-assessed yet, so every requirement reads as a full gap. Rate your
          skills on the <strong>Self-assessment</strong> tab and this report becomes meaningful.
        </Banner>
      )}

      <div className="grid sidebar-right">
        <Card
          title="Ranked by what it costs you"
          actions={<span className="small muted">gap × importance</span>}
        >
          {outstanding.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Category</th>
                    <th className="right">Have</th>
                    <th className="right">Need</th>
                    <th className="right">Gap</th>
                    <th className="right">Importance</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.map((item) => (
                    <tr key={item.skill_id}>
                      <td>
                        {item.name}
                        {item.unassessed && <div className="small muted">never rated</div>}
                      </td>
                      <td className="muted">{item.category}</td>
                      <td className="right">{item.current_level}</td>
                      <td className="right">{item.required_level}</td>
                      <td className="right tabular">{item.gap}</td>
                      <td className="right muted">{item.importance}</td>
                      <td>
                        <Chip tone={STATUS_TONE[item.status]}>{item.status}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓" title="No gaps against this role" hint="Every requirement is met." />
          )}
        </Card>

        <Card title="Biggest priorities">
          {outstanding.length ? (
            <RankedBars
              items={outstanding.slice(0, 8).map((i) => ({ label: i.name, value: i.priority }))}
              format={(v) => String(Math.round(v))}
            />
          ) : (
            <Empty icon="✓" title="Nothing outstanding" />
          )}
        </Card>
      </div>

      <Card title="Already met" >
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {items.filter((i) => i.gap === 0).map((i) => (
            <Chip key={i.skill_id} tone="good">
              {i.name}
              {i.surplus > 0 && <span className="muted"> +{i.surplus}</span>}
            </Chip>
          ))}
          {items.every((i) => i.gap > 0) && <span className="muted small">Nothing yet.</span>}
        </div>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------- assessment ---

function AssessTab({ occupationId }: { occupationId: number | null }) {
  const profile = useApi<{ items: ProfileRow[]; scale: Rung[] }>(
    `/skills-profile${occupationId ? `?occupation_id=${occupationId}` : ''}`,
    [occupationId]
  );
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const [onlyRequired, setOnlyRequired] = useState(true);

  const rows = profile.data?.items ?? [];
  const scale = profile.data?.scale ?? [];
  const visible = onlyRequired && occupationId ? rows.filter((r) => r.importance !== null) : rows;

  const byCategory = useMemo(() => {
    const groups = new Map<string, ProfileRow[]>();
    for (const row of visible) {
      const list = groups.get(row.category) ?? [];
      list.push(row);
      groups.set(row.category, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const dirty = Object.keys(draft).length;

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/skill-assessments', {
        items: Object.entries(draft).map(([skillId, level]) => ({
          skill_id: Number(skillId),
          level,
        })),
      });
      setSaved(dirty);
      setDraft({});
      await profile.reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Rate what you can do today</div>
            <div className="small muted">
              Every rating is stored as a new dated row, so the history shows whether you are
              actually moving. Nothing is overwritten.
            </div>
          </div>
          <span className="spacer" />
          {occupationId && (
            <label className="small muted row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={onlyRequired}
                onChange={(e) => setOnlyRequired(e.target.checked)}
              />
              Only this role's skills
            </label>
          )}
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : dirty ? `Save ${dirty} rating(s)` : 'Saved'}
          </button>
        </div>
        {saved > 0 && !dirty && <Banner tone="ok">Recorded {saved} rating(s).</Banner>}
      </Card>

      {byCategory.map(([category, items]) => (
        <Card key={category} title={category}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th style={{ width: '45%' }}>Your level</th>
                  <th className="right">Role needs</th>
                  <th className="right">Last rated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const value = draft[row.skill_id] ?? row.current_level;
                  return (
                    <tr key={row.skill_id}>
                      <td>{row.name}</td>
                      <td>
                        <select
                          value={value}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [row.skill_id]: Number(e.target.value) }))
                          }
                          style={{ width: '100%' }}
                        >
                          {scale.map((rung) => (
                            <option key={rung.value} value={rung.value}>
                              {rung.label} — {rung.hint}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="right">
                        {row.required_level === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={value < row.required_level ? 'neg' : 'pos'}>
                            {row.required_level}
                          </span>
                        )}
                      </td>
                      <td className="right muted small">
                        {row.assessed_on ? formatDate(row.assessed_on) : 'never'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {!profile.loading && !visible.length && (
        <Card><Empty icon="◐" title="No skills to rate" /></Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ plans ----

function PlanTab({ occupationId }: { occupationId: number | null }) {
  const plans = useApi<ListResponse<Plan>>('/learning-plans');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [weekly, setWeekly] = useState(180);
  const [size, setSize] = useState(8);

  const generate = async () => {
    if (!occupationId) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/learning-plans/generate', {
        occupation_id: occupationId,
        weekly_minutes: weekly,
        limit: size,
      });
      await plans.reload();
    } catch (err: any) {
      setError(err?.message ?? 'Could not generate a plan');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Generate a plan">
        <Banner tone="error">{error}</Banner>
        <div className="field-row">
          <Field label="Hours a week you can actually study" hint="Used to lay the plan across a calendar">
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={weekly / 60}
              onChange={(e) => setWeekly(Math.round(Number(e.target.value) * 60))}
            />
          </Field>
          <Field label="How many skills to take on" hint="The rest stay in the gap report">
            <input
              type="number"
              min={1}
              max={40}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
          </Field>
        </div>
        <button className="btn primary" disabled={!occupationId || busy} onClick={generate}>
          {busy ? 'Building…' : 'Generate from current gaps'}
        </button>
      </Card>

      {(plans.data?.items ?? []).map((plan) => (
        <PlanCard key={plan.id} plan={plan} onChanged={() => void plans.reload()} />
      ))}

      {!plans.loading && !(plans.data?.items ?? []).length && (
        <Card><Empty icon="◇" title="No plans yet" hint="Generate one from your current gap report." /></Card>
      )}
    </div>
  );
}

function PlanCard({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const setStatus = async (item: PlanItem, status: PlanItem['status']) => {
    setBusy(true);
    try {
      await api.patch(`/learning-plans/${plan.id}/items/${item.id}`, { status });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const pushTasks = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ created: number; already_linked: number }>(
        `/learning-plans/${plan.id}/push-tasks`
      );
      setNote(
        result.created
          ? `Created ${result.created} task(s) in Tasks.`
          : `Already linked (${result.already_linked} task(s)).`
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={plan.name}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" disabled={busy} onClick={pushTasks}>
            Push to Tasks
          </button>
          <ConfirmButton
            onConfirm={async () => {
              await api.del(`/learning-plans/${plan.id}`);
              onChanged();
            }}
          >
            Delete
          </ConfirmButton>
        </div>
      }
    >
      {note && <Banner tone="ok">{note}</Banner>}
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <ProgressBar percent={plan.progress.percent} />
        </div>
        <span className="small muted">
          {plan.progress.done}/{plan.progress.total} steps ·{' '}
          {minutesToHours(plan.progress.minutes_done)} of {minutesToHours(plan.progress.minutes_total)}
        </span>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Step</th>
              <th>Course</th>
              <th className="right">Effort</th>
              <th className="right">Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {plan.items.map((item, index) => (
              <tr key={item.id}>
                <td>
                  <span className="muted">{index + 1}.</span> {item.skill_name}
                  <div className="small muted">
                    {item.from_level} → {item.target_level}
                    {item.task_id ? ' · linked to a task' : ''}
                  </div>
                </td>
                <td className="truncate">
                  {item.go_url ? (
                    <a href={item.go_url} target="_blank" rel="noopener noreferrer nofollow sponsored">
                      {item.resource_title}
                    </a>
                  ) : (
                    <span className="muted small">none picked</span>
                  )}
                </td>
                <td className="right">{minutesToHours(item.estimate_minutes)}</td>
                <td className="right muted small">
                  {item.due_date ? (
                    <span className={item.status !== 'done' && item.due_date < new Date().toISOString().slice(0, 10) ? 'neg' : ''}>
                      {relativeDay(item.due_date)}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <select
                    value={item.status}
                    disabled={busy}
                    onChange={(e) => setStatus(item, e.target.value as PlanItem['status'])}
                  >
                    <option value="todo">To do</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Done</option>
                    <option value="skipped">Skipped</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">
        Marking a step done also records a new self-assessment at its target level, so the next
        gap report reflects it.
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- courses ----

function CoursesTab() {
  const skills = useApi<ListResponse<{ id: number; name: string; category: string; resource_count: number }>>(
    '/skills?archived=0&limit=500'
  );
  const [skillId, setSkillId] = useState<number | null>(null);
  const resources = useApi<ListResponse<Resource>>(
    skillId ? `/learning-resources?skill_id=${skillId}` : '/learning-resources',
    [skillId]
  );
  const affiliate = useApi<{ disclosure: string; network: string }>('/affiliate-settings');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');

  const checkLinks = async () => {
    setChecking(true);
    setCheckNote('');
    try {
      const result = await api.post<{ checked: number; dead: number }>(
        '/learning-resources/check',
        skillId ? { skill_id: skillId } : {}
      );
      setCheckNote(
        result.dead
          ? `${result.dead} of ${result.checked} link(s) did not resolve.`
          : `All ${result.checked} link(s) resolved.`
      );
      await resources.reload();
    } catch (err: any) {
      setCheckNote(err?.message ?? 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const runSearch = async () => {
    if (!skillId) return;
    setSearching(true);
    setSearchError('');
    try {
      const result = await api.post<{ error: string | null; items: unknown[] }>('/udemy/search', {
        skill_id: skillId,
      });
      if (result.error) setSearchError(result.error);
      await resources.reload();
    } catch (err: any) {
      setSearchError(err?.message ?? 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const items = resources.data?.items ?? [];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
          <Field label="Skill">
            <select
              value={skillId ?? ''}
              onChange={(e) => setSkillId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All skills</option>
              {(skills.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.resource_count})
                </option>
              ))}
            </select>
          </Field>
          <span className="spacer" />
          <button className="btn" disabled={!skillId || searching} onClick={runSearch}>
            {searching ? 'Searching…' : 'Search Udemy'}
          </button>
          <button className="btn" disabled={!items.length || checking} onClick={checkLinks}>
            {checking ? 'Checking…' : 'Check links'}
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Add by URL
          </button>
          <button className="btn primary" onClick={() => setBulkOpen(true)}>
            Paste a list
          </button>
        </div>
        {searchError && <Banner tone="error">{searchError}</Banner>}
        {checkNote && <Banner tone={checkNote.includes('did not') ? 'error' : 'ok'}>{checkNote}</Banner>}
        {affiliate.data?.disclosure && (
          <div className="small muted">{affiliate.data.disclosure}</div>
        )}
      </Card>

      <Card title="Catalogue">
        {items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Provider</th>
                  <th className="right">Rating</th>
                  <th className="right">Length</th>
                  <th className="right">Price</th>
                  <th className="right">Clicks</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.title}
                      {r.link_ok === false && (
                        <Chip tone="critical">link dead</Chip>
                      )}
                      {r.instructor && <div className="small muted">{r.instructor}</div>}
                    </td>
                    <td>
                      <Chip tone={r.affiliate_network ? 'accent' : ''}>
                        {r.provider}
                        {r.affiliate_network ? ` · ${r.affiliate_network}` : ''}
                      </Chip>
                    </td>
                    <td className="right">{r.rating ? r.rating.toFixed(1) : '—'}</td>
                    <td className="right muted">
                      {r.duration_minutes ? minutesToHours(r.duration_minutes) : '—'}
                    </td>
                    <td className="right">{r.price_cents ? money(r.price_cents, r.currency) : '—'}</td>
                    <td className="right tabular">{r.clicks}</td>
                    <td className="right">
                      <a
                        className="btn sm"
                        href={r.go_url}
                        target="_blank"
                        rel="noopener noreferrer nofollow sponsored"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="◇"
            title="No courses catalogued"
            hint="Search Udemy (needs API credentials) or paste a course URL — both work."
          />
        )}
      </Card>

      {bulkOpen && (
        <BulkImportModal
          defaultSkillId={skillId}
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setBulkOpen(false);
            void resources.reload();
            void skills.reload();
          }}
        />
      )}

      {importOpen && (
        <ImportCourseModal
          skills={skills.data?.items ?? []}
          defaultSkillId={skillId}
          onClose={() => setImportOpen(false)}
          onSaved={() => {
            setImportOpen(false);
            void resources.reload();
            void skills.reload();
          }}
        />
      )}
    </div>
  );
}

function ImportCourseModal({
  skills,
  defaultSkillId,
  onClose,
  onSaved,
}: {
  skills: Array<{ id: number; name: string }>;
  defaultSkillId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [skillId, setSkillId] = useState<number | null>(defaultSkillId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/udemy/import', { url, title: title || undefined, skill_id: skillId });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not add that course');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add a Udemy course"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!url || busy} onClick={submit}>
            {busy ? 'Adding…' : 'Add course'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner tone="error">{error}</Banner>
        <Field label="Course URL" hint="https://www.udemy.com/course/…">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.udemy.com/course/..." />
        </Field>
        <Field label="Title" hint="Optional — without the API there is no metadata to fetch">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Skill">
          <select
            value={skillId ?? ''}
            onChange={(e) => setSkillId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Unassigned</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function BulkImportModal({
  defaultSkillId,
  onClose,
  onSaved,
}: {
  defaultSkillId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: Array<{ line: string; reason: string }> } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<any>('/learning-resources/bulk', {
        text,
        skill_id: defaultSkillId,
      });
      setResult(res);
      if (!res.skipped) onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Paste a list of courses"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={result ? onSaved : onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={submit}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner tone="error">{error}</Banner>
        <p className="small muted" style={{ margin: 0 }}>
          One course per line. Name the skill by code or by name, separated with a pipe or a tab.
          The URL can sit in any column. Lines starting with <code>#</code> are ignored.
        </p>
        <pre className="small muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`https://www.udemy.com/course/slug/
starter:seo | https://www.udemy.com/course/slug/
SEO | https://www.udemy.com/course/slug/ | The SEO Bootcamp`}
        </pre>
        <Field
          label="Courses"
          hint={
            defaultSkillId
              ? 'Lines without a skill go to the skill selected behind this dialog.'
              : 'Lines without a skill are left unassigned.'
          }
        >
          <textarea
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://www.udemy.com/course/..."
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </Field>

        {result && (
          <>
            <Banner tone={result.skipped ? 'error' : 'ok'}>
              Imported {result.imported} course(s){result.skipped ? `, skipped ${result.skipped}` : ''}. Courses already in the catalogue were updated in place.
            </Banner>
            {result.errors.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Line</th><th>Why</th></tr></thead>
                  <tbody>
                    {result.errors.map((e, i) => (
                      <tr key={i}>
                        <td className="truncate small">{e.line}</td>
                        <td className="small neg">{e.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------- affiliate ----

const NETWORKS = [
  { id: 'none', label: 'Not configured — plain links' },
  { id: 'direct', label: 'Direct link with tracking params' },
  { id: 'impact', label: 'Impact (Udemy’s current network)' },
  { id: 'linksynergy', label: 'Rakuten / LinkSynergy' },
  { id: 'custom', label: 'Custom template' },
];

function AffiliateTab() {
  const settings = useApi<any>('/affiliate-settings');
  const report = useApi<any>('/affiliate-report?days=90');
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const current = form ?? (settings.data ? { ...settings.data } : null);
  if (!current) return <div className="muted">Loading…</div>;

  const set = (key: string, value: string) => {
    setForm({ ...current, [key]: value });
    setSaved(false);
  };

  const save = async () => {
    const next = await api.patch<any>('/affiliate-settings', current);
    setForm({ ...next });
    setSaved(true);
    void settings.reload();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-3">
        <Card>
          <Stat label="Clicks (90d)" value={num(report.data?.total_clicks ?? 0)} />
        </Card>
        <Card>
          <Stat
            label="Tracked clicks"
            value={num(report.data?.tracked_clicks ?? 0)}
            sub={
              (report.data?.total_clicks ?? 0) > (report.data?.tracked_clicks ?? 0)
                ? 'Some links went out untracked'
                : 'All tracked'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Udemy API"
            value={settings.data?.udemy_api_configured ? 'Connected' : 'Not connected'}
            sub={
              settings.data?.udemy_api_configured
                ? 'Course search is available'
                : 'Optional — pasting course URLs works without it'
            }
            small
          />
          <button className="btn sm" onClick={() => setConnectOpen(true)}>
            {settings.data?.udemy_api_configured ? 'Replace credentials' : 'Connect'}
          </button>
        </Card>
      </div>

      <Card title="How outbound links are built">
        <Banner>
          Helm builds your tracked link at click time from the plain course URL, so changing
          network here re-points every course at once. Commission attribution still happens on the
          network's side — this only controls the link and logs the click.
        </Banner>
        {saved && <Banner tone="ok">Saved.</Banner>}

        <Field label="Network">
          <select value={current.network} onChange={(e) => set('network', e.target.value)}>
            {NETWORKS.map((n) => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </select>
        </Field>

        {current.network === 'impact' && (
          <Field
            label="Deep-link base"
            hint="Copy it from your Impact dashboard. Helm appends ?u=<course URL>."
          >
            <input value={current.linkBase} onChange={(e) => set('linkBase', e.target.value)} />
          </Field>
        )}

        {current.network === 'linksynergy' && (
          <div className="field-row">
            <Field label="Publisher ID">
              <input value={current.publisherId} onChange={(e) => set('publisherId', e.target.value)} />
            </Field>
            <Field label="Merchant ID (mid)" hint="Udemy's is commonly 39197 — confirm in your dashboard">
              <input value={current.advertiserId} onChange={(e) => set('advertiserId', e.target.value)} />
            </Field>
          </div>
        )}

        {current.network === 'custom' && (
          <Field label="Template" hint="Use {url} or {encoded_url} for the destination">
            <input value={current.template} onChange={(e) => set('template', e.target.value)} />
          </Field>
        )}

        <Field
          label="Extra parameters on the course URL"
          hint="e.g. utm_source=helm&utm_medium=plan — added before the link is wrapped"
        >
          <input value={current.extraParams} onChange={(e) => set('extraParams', e.target.value)} />
        </Field>

        <Field
          label="Disclosure"
          hint="Shown beside affiliate links. The FTC requires one, and so do Udemy's terms."
        >
          <input value={current.disclosure} onChange={(e) => set('disclosure', e.target.value)} />
        </Field>

        {settings.data?.sample_url && (
          <div className="small muted">
            Sample link:{' '}
            <code style={{ wordBreak: 'break-all' }}>{settings.data.sample_url}</code>
            {!settings.data.sample_tracked && (
              <strong> — not tracked; the configuration above is incomplete.</strong>
            )}
          </div>
        )}

        <button className="btn primary" onClick={save}>Save</button>
      </Card>

      {connectOpen && (
        <ConnectUdemyModal
          onClose={() => setConnectOpen(false)}
          onSaved={() => {
            setConnectOpen(false);
            void settings.reload();
          }}
        />
      )}

      <Card title="Most clicked (90 days)">
        {(report.data?.by_resource ?? []).length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Skill</th>
                  <th className="right">Clicks</th>
                  <th className="right">Last</th>
                </tr>
              </thead>
              <tbody>
                {report.data.by_resource.map((row: any) => (
                  <tr key={row.id}>
                    <td className="truncate">{row.title}</td>
                    <td className="muted">{row.skill_name ?? '—'}</td>
                    <td className="right tabular">{row.clicks}</td>
                    <td className="right muted small">{formatDate(row.last_click)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="◇" title="No clicks recorded yet" />
        )}
      </Card>
    </div>
  );
}

/**
 * Udemy Affiliate API credentials.
 *
 * Write-only, like every other credential in Helm: the plaintext is encrypted
 * on the way in and the API never returns it, so this form always starts
 * empty even when a credential is already stored.
 */
function ConnectUdemyModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/settings/credentials', {
        service: 'udemy',
        label: 'Udemy Affiliate API',
        data: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? 'Could not save the credentials');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Connect the Udemy Affiliate API"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!clientId.trim() || !clientSecret.trim() || busy}
            onClick={submit}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner tone="error">{error}</Banner>
        <Banner>
          Entirely optional. Without it you can still paste course URLs, import a list, and build
          tracked links — only the <strong>Search Udemy</strong> button needs it. The Affiliate API
          is granted to approved affiliates only, so it may be declined.
        </Banner>
        <Field label="Client ID">
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Client Secret" hint="Encrypted at rest; never returned by the API">
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <div className="small muted">
          Saving replaces any Udemy credential already stored — the newest is the one used.
        </div>
      </div>
    </Modal>
  );
}
