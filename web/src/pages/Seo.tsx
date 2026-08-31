import React, { useEffect, useState } from 'react';
import { api, useApi, type ListResponse } from '../lib/api';
import { Banner, Card, Chip, ConfirmButton, Empty, Field, Modal, Stat, Tabs } from '../components/ui';
import { LineChart, RankedBars, ScoreRing } from '../components/charts';
import { formatDate, formatDateTime, num } from '../lib/format';

type Site = {
  id: number;
  name: string;
  base_url: string;
  keyword_count: number;
  last_crawl: { id: number; status: string; started_at: string; pages_crawled: number; health_score: number } | null;
};

type Keyword = {
  id: number;
  keyword: string;
  volume: number;
  difficulty: number;
  intent: string;
  target_url: string;
  tracked: number;
  latest_position: number | null;
  latest_checked: string | null;
  ai_overview: boolean;
  delta: number | null;
  history: Array<{ checked_on: string; position: number | null }>;
};

type Overview = {
  site: Site;
  crawl: any;
  keywords: {
    total: number;
    tracked: number;
    ranked: number;
    ai_overviews: number;
    avg_position: number | null;
    buckets: Record<string, number>;
    improving: number;
    declining: number;
  };
  movers: Keyword[];
  briefs: Array<{ id: number; title: string; status: string; created_at: string }>;
};

const SEVERITY_TONE: Record<string, 'critical' | 'warning' | ''> = {
  critical: 'critical',
  warning: 'warning',
  notice: '',
};

type Tab = 'overview' | 'console' | 'audit' | 'keywords' | 'ideas' | 'briefs';

export function SeoPage() {
  const sites = useApi<ListResponse<Site>>('/seo-sites');
  const [siteId, setSiteId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [addingSite, setAddingSite] = useState(false);
  const [notice, setNotice] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('connected') ? `${p.get('connected')} connected.` : null;
  });

  const list = sites.data?.items ?? [];
  const active = siteId ?? list[0]?.id ?? null;

  useEffect(() => {
    if (siteId === null && list.length) setSiteId(list[0].id);
  }, [list, siteId]);

  return (
    <>
      <header className="topbar">
        <h1>SEO &amp; AEO</h1>
        {list.length > 0 && (
          <select value={String(active ?? '')} onChange={(e) => setSiteId(Number(e.target.value))} style={{ width: 220 }}>
            {list.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => setAddingSite(true)}>+ Add site</button>
      </header>

      <div className="page stack" style={{ gap: 14 }}>
        {notice && (
          <div className="banner ok">
            <div className="row">
              <span style={{ flex: 1 }}>{notice}</span>
              <button
                className="btn sm ghost"
                onClick={() => {
                  setNotice(null);
                  window.history.replaceState({}, '', '/seo');
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {!list.length ? (
          <Card>
            <Empty
              icon="◎"
              title="No sites yet"
              hint="Add a site to crawl it for technical SEO problems and score it for answer-engine readiness."
            />
          </Card>
        ) : (
          <>
            <Tabs
              tabs={[
                { id: 'overview', label: 'Overview' },
                { id: 'console', label: 'Search Console' },
                { id: 'audit', label: 'Site audit' },
                { id: 'keywords', label: 'Keywords' },
                { id: 'ideas', label: 'Keyword ideas' },
                { id: 'briefs', label: 'Content briefs' },
              ]}
              active={tab}
              onChange={setTab}
            />
            {active && tab === 'overview' && <OverviewTab siteId={active} onGoTo={setTab} />}
            {active && tab === 'console' && <SearchConsoleTab siteId={active} />}
            {active && tab === 'audit' && <AuditTab siteId={active} onCrawled={() => void sites.reload()} />}
            {active && tab === 'keywords' && <KeywordsTab siteId={active} />}
            {active && tab === 'ideas' && <IdeasTab siteId={active} />}
            {active && tab === 'briefs' && <BriefsTab siteId={active} />}
          </>
        )}
      </div>

      {addingSite && (
        <SiteForm
          onClose={() => setAddingSite(false)}
          onSaved={() => {
            setAddingSite(false);
            void sites.reload();
          }}
        />
      )}
    </>
  );
}

function SiteForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal
      title="Add site"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!name.trim() || !url.trim()}
            onClick={async () => {
              try {
                await api.post('/seo-sites', { name, base_url: url });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not save');
              }
            }}
          >
            Add
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="URL" hint="https:// is assumed if you leave the scheme off">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com" />
      </Field>
    </Modal>
  );
}

function OverviewTab({ siteId, onGoTo }: { siteId: number; onGoTo: (tab: any) => void }) {
  const { data } = useApi<Overview>(`/seo-overview?site_id=${siteId}`, [siteId]);
  const site = useApi<any>(`/seo-sites/${siteId}`, [siteId]);
  const [authError, setAuthError] = useState('');
  const [checking, setChecking] = useState(false);
  if (!data) return <div className="muted">Loading…</div>;
  const authority = site.data?.authority ?? {};

  const checks = data.crawl?.site_checks ?? {};
  const aiBots = (checks.ai_bots_allowed ?? {}) as Record<string, boolean>;
  const buckets = data.keywords.buckets ?? {};

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid cols-4">
        <Card>
          <div className="row" style={{ gap: 12 }}>
            <ScoreRing score={data.crawl?.health_score ?? 0} label="Site health" />
            <Stat
              label="Site health"
              value={data.crawl?.health_score ?? '—'}
              sub={data.crawl ? `${data.crawl.pages_crawled} pages` : 'not crawled yet'}
              small
            />
          </div>
        </Card>
        <Card>
          <Stat
            label="Avg position"
            value={data.keywords.avg_position ?? '—'}
            sub={`${data.keywords.ranked} of ${data.keywords.total} ranking`}
          />
        </Card>
        <Card>
          <Stat
            label="Top 3"
            value={num(buckets.top3 ?? 0)}
            sub={`${num(buckets.top10 ?? 0)} in 4–10`}
          />
        </Card>
        <Card>
          <Stat
            label="AI answer citations"
            value={num(data.keywords.ai_overviews)}
            sub="keywords cited in AI overviews"
          />
        </Card>
      </div>

      <Card
        title="Domain authority"
        actions={
          <button
            className="btn sm"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setAuthError('');
              try {
                await api.post(`/seo-sites/${siteId}/authority`);
                void site.reload();
              } catch (err: any) {
                setAuthError(err?.message ?? 'Could not fetch authority');
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
        }
      >
        {authority.score != null ? (
          <div className="row" style={{ gap: 16 }}>
            <ScoreRing score={authority.score} label="Authority" />
            <div>
              <Stat
                label={authority.source}
                value={`${authority.raw} / 10`}
                sub={authority.rank ? `global rank #${num(authority.rank)}` : undefined}
                small
              />
            </div>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Not checked yet. Moz's Domain Authority and Ahrefs' Domain Rating are proprietary scores
            computed from their own crawls of the web's link graph, so they cannot be calculated
            locally. Helm reads Open PageRank instead — a free, comparable third-party measure.
          </p>
        )}
        {authError && <Banner tone="error">{authError}</Banner>}
      </Card>

      <div className="grid sidebar-right">
        <Card title="Rank distribution">
          <RankedBars
            items={[
              { label: 'Positions 1–3', value: buckets.top3 ?? 0 },
              { label: 'Positions 4–10', value: buckets.top10 ?? 0 },
              { label: 'Positions 11–20', value: buckets.top20 ?? 0 },
              { label: 'Positions 21–50', value: buckets.top50 ?? 0 },
              { label: 'Beyond 50', value: buckets.beyond ?? 0 },
              { label: 'Not ranking', value: buckets.unranked ?? 0 },
            ]}
            format={(v) => `${v} kw`}
          />
        </Card>

        <Card title="Answer-engine readiness">
          <div className="check-list">
            <CheckItem passed={!!checks.robots_txt} label="robots.txt present" />
            <CheckItem passed={!!checks.sitemap_xml} label="sitemap.xml present" />
            <CheckItem
              passed={!!checks.llms_txt}
              label="llms.txt present"
              hint="Publishes a guide for AI crawlers"
            />
            {Object.entries(aiBots).map(([bot, allowed]) => (
              <CheckItem key={bot} passed={allowed} label={`${bot} allowed`} />
            ))}
          </div>
          {!data.crawl && <p className="small muted">Run a crawl to populate these.</p>}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Biggest movers">
          {data.movers.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Keyword</th><th className="right">Position</th><th className="right">Change</th></tr>
                </thead>
                <tbody>
                  {data.movers.map((kw) => (
                    <tr key={kw.id}>
                      <td className="truncate">{kw.keyword}</td>
                      <td className="right">{kw.latest_position ?? '—'}</td>
                      <td className="right">
                        <span className={(kw.delta ?? 0) > 0 ? 'pos' : 'neg'}>
                          {(kw.delta ?? 0) > 0 ? '▲' : '▼'} {Math.abs(kw.delta ?? 0)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="◎" title="No movement recorded" hint="Track positions to see changes over time." />
          )}
        </Card>

        <Card title="Content briefs" actions={<button className="btn sm" onClick={() => onGoTo('briefs')}>Open</button>}>
          {data.briefs.length ? (
            data.briefs.map((brief) => (
              <div className="task-row" key={brief.id}>
                <span className="title truncate">{brief.title}</span>
                <Chip>{brief.status}</Chip>
              </div>
            ))
          ) : (
            <Empty icon="✎" title="No briefs yet" />
          )}
        </Card>
      </div>
    </div>
  );
}

function CheckItem({ passed, label, hint }: { passed: boolean; label: string; hint?: string }) {
  return (
    <div className="check-item">
      <span className={`check-mark ${passed ? 'pass' : 'fail'}`} aria-hidden="true">{passed ? '✓' : '✕'}</span>
      <span>
        {label}
        {hint && <span className="muted small"> — {hint}</span>}
      </span>
    </div>
  );
}

function AuditTab({ siteId, onCrawled }: { siteId: number; onCrawled: () => void }) {
  const crawls = useApi<ListResponse<any>>(`/seo-crawls?site_id=${siteId}`, [siteId]);
  const [crawlId, setCrawlId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const list = crawls.data?.items ?? [];
  const active = crawlId ?? list[0]?.id ?? null;
  const report = useApi<any>(active ? `/seo-crawls/${active}/report` : null, [active]);

  const running = list.find((c) => c.status === 'running');

  // Poll while a crawl is in flight so progress appears without a refresh.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      void crawls.reload();
      void report.reload();
    }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id]);

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      const crawl = await api.post<any>(`/seo-sites/${siteId}/crawl`, { max_pages: 50 });
      setCrawlId(crawl.id);
      void crawls.reload();
      onCrawled();
    } catch (err: any) {
      setError(err?.message ?? 'Could not start crawl');
    } finally {
      setStarting(false);
    }
  };

  const data = report.data;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row wrap">
          <button className="btn primary" onClick={start} disabled={starting || !!running}>
            {running ? `Crawling… ${running.pages_crawled} pages` : starting ? 'Starting…' : 'Run crawl'}
          </button>
          {list.length > 1 && (
            <select value={String(active ?? '')} onChange={(e) => setCrawlId(Number(e.target.value))} style={{ width: 260 }}>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatDateTime(c.started_at)} — {c.status} ({c.pages_crawled} pages)
                </option>
              ))}
            </select>
          )}
          <span className="spacer" />
          {data?.crawl && <span className="small muted">Health {data.crawl.health_score}/100</span>}
        </div>
        {error && <Banner tone="error">{error}</Banner>}
        {data?.crawl?.error && <Banner tone="error">{data.crawl.error}</Banner>}
      </Card>

      {!data ? (
        <Card><Empty icon="◎" title="No crawl yet" hint="Run a crawl to audit every page." /></Card>
      ) : (
        <>
          <div className="grid cols-4">
            <Card><Stat label="Pages" value={num(data.totals.pages)} /></Card>
            <Card><Stat label="Critical issues" value={<span className="neg">{num(data.totals.critical)}</span>} /></Card>
            <Card><Stat label="Warnings" value={num(data.totals.warnings)} /></Card>
            <Card><Stat label="Avg AEO score" value={`${data.totals.avg_aeo}/100`} sub={`${data.totals.avg_words} words avg`} /></Card>
          </div>

          <div className="grid sidebar-right">
            <Card title="Pages" padded={false}>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th className="right">Status</th>
                      <th className="right">Words</th>
                      <th className="right">AEO</th>
                      <th className="right">Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.map((page: any) => (
                      <tr key={page.id}>
                        <td className="truncate" style={{ maxWidth: 320 }} title={page.url}>
                          {page.url.replace(/^https?:\/\/[^/]+/, '') || '/'}
                        </td>
                        <td className="right">
                          <Chip tone={page.status_code === 200 ? 'good' : 'critical'}>{page.status_code || 'err'}</Chip>
                        </td>
                        <td className="right">{num(page.word_count)}</td>
                        <td className="right">
                          <span className={page.aeo_score >= 70 ? 'pos' : page.aeo_score >= 40 ? '' : 'neg'}>
                            {page.aeo_score}
                          </span>
                        </td>
                        <td className="right">{page.issue_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Issues found">
              {data.issues.length ? (
                <div className="stack" style={{ gap: 8 }}>
                  {data.issues.map((issue: any) => (
                    <div key={issue.code}>
                      <div className="row between">
                        <Chip tone={SEVERITY_TONE[issue.severity] ?? ''}>{issue.severity}</Chip>
                        <strong className="tabular">{issue.count}</strong>
                      </div>
                      <div className="small dim" style={{ marginTop: 3 }}>{issue.message}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty icon="✓" title="No issues found" />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function KeywordsTab({ siteId }: { siteId: number }) {
  const keywords = useApi<ListResponse<Keyword>>(`/seo-keywords?site_id=${siteId}&limit=500`, [siteId]);
  const providers = useApi<{ items: any[]; active: string }>('/seo-providers');
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<Keyword | null>(null);
  const [error, setError] = useState('');

  const items = keywords.data?.items ?? [];
  const manual = providers.data?.active === 'manual';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card>
        <div className="row wrap">
          <button className="btn primary" onClick={() => setAdding(true)}>+ Add keyword</button>
          {manual && (
            <span className="small muted">
              No SERP API configured — record positions by hand, or set a provider in Settings.
            </span>
          )}
        </div>
        {error && <Banner tone="error">{error}</Banner>}
      </Card>

      <Card padded={false}>
        {items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Intent</th>
                  <th className="right">Volume</th>
                  <th className="right">Difficulty</th>
                  <th className="right">Position</th>
                  <th className="right">Change</th>
                  <th>AI</th>
                  <th className="right">Checked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((kw) => (
                  <tr key={kw.id}>
                    <td>
                      <button
                        onClick={() => setDetail(kw)}
                        style={{ background: 'none', border: 'none', font: 'inherit', color: 'var(--accent-ink)', cursor: 'pointer', padding: 0 }}
                      >
                        {kw.keyword}
                      </button>
                    </td>
                    <td>{kw.intent && <Chip>{kw.intent}</Chip>}</td>
                    <td className="right">{num(kw.volume)}</td>
                    <td className="right">{kw.difficulty || '—'}</td>
                    <td className="right">
                      <strong>{kw.latest_position ?? '—'}</strong>
                    </td>
                    <td className="right">
                      {kw.delta ? (
                        <span className={kw.delta > 0 ? 'pos' : 'neg'}>
                          {kw.delta > 0 ? '▲' : '▼'} {Math.abs(kw.delta)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{kw.ai_overview ? <Chip tone="good">cited</Chip> : ''}</td>
                    <td className="right small muted">{kw.latest_checked ? formatDate(kw.latest_checked) : 'never'}</td>
                    <td className="right">
                      {!manual && (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await api.post(`/seo-keywords/${kw.id}/check`);
                              void keywords.reload();
                            } catch (err: any) {
                              setError(err?.message ?? 'Rank check failed');
                            }
                          }}
                        >
                          Check
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="◎" title="No keywords tracked" hint="Add the terms you want to rank for." />
        )}
      </Card>

      {adding && (
        <KeywordForm
          siteId={siteId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void keywords.reload();
          }}
        />
      )}

      {detail && (
        <KeywordDetail
          keyword={detail}
          onClose={() => setDetail(null)}
          onChanged={() => void keywords.reload()}
        />
      )}
    </div>
  );
}

function KeywordForm({ siteId, onClose, onSaved }: { siteId: number; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ keyword: '', volume: 0, difficulty: 0, intent: 'informational', target_url: '' });
  const [error, setError] = useState('');

  return (
    <Modal
      title="Add keyword"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!form.keyword.trim()}
            onClick={async () => {
              try {
                await api.post('/seo-keywords', { ...form, site_id: siteId });
                onSaved();
              } catch (err: any) {
                setError(err?.message ?? 'Could not save');
              }
            }}
          >
            Add
          </button>
        </>
      }
    >
      <Banner tone="error">{error}</Banner>
      <Field label="Keyword">
        <input autoFocus value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Monthly volume">
          <input type="number" value={form.volume} onChange={(e) => setForm({ ...form, volume: Number(e.target.value) })} />
        </Field>
        <Field label="Difficulty (0–100)">
          <input type="number" value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="Intent">
        <select value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })}>
          {['informational', 'commercial', 'transactional', 'navigational'].map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </Field>
      <Field label="Target URL">
        <input value={form.target_url} onChange={(e) => setForm({ ...form, target_url: e.target.value })} placeholder="https://" />
      </Field>
    </Modal>
  );
}

function KeywordDetail({
  keyword,
  onClose,
  onChanged,
}: {
  keyword: Keyword;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, reload } = useApi<{ items: Array<{ checked_on: string; position: number | null }> }>(
    `/seo-keywords/${keyword.id}/history`,
    [keyword.id]
  );
  const [position, setPosition] = useState('');
  const [generating, setGenerating] = useState(false);
  const [brief, setBrief] = useState<any>(null);
  const [error, setError] = useState('');

  const history = (data?.items ?? []).slice().reverse();

  return (
    <Modal title={keyword.keyword} wide onClose={onClose}>
      <Banner tone="error">{error}</Banner>

      <div className="grid cols-4">
        <Stat label="Position" value={keyword.latest_position ?? '—'} small />
        <Stat label="Volume" value={num(keyword.volume)} small />
        <Stat label="Difficulty" value={keyword.difficulty || '—'} small />
        <Stat label="AI overview" value={keyword.ai_overview ? 'cited' : 'no'} small />
      </div>

      {history.length > 1 && (
        <div>
          <div className="stat-label">Position over time (lower is better)</div>
          <LineChart
            points={history.map((h) => ({ x: formatDate(h.checked_on), y: h.position }))}
            invert
            label="Position"
            format={(v) => `#${v}`}
          />
        </div>
      )}

      <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
        <Field label="Record today's position">
          <input
            type="number"
            min={1}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="e.g. 7"
          />
        </Field>
        <button
          className="btn"
          disabled={!position}
          onClick={async () => {
            await api.post(`/seo-keywords/${keyword.id}/rankings`, { position: Number(position) });
            setPosition('');
            void reload();
            onChanged();
          }}
        >
          Save
        </button>
        <button
          className="btn"
          onClick={async () => {
            await api.post(`/seo-keywords/${keyword.id}/rankings`, { position: null });
            void reload();
            onChanged();
          }}
        >
          Not ranking
        </button>
      </div>

      <div>
        <button
          className="btn primary"
          disabled={generating}
          onClick={async () => {
            setGenerating(true);
            setError('');
            try {
              setBrief(await api.post('/content-briefs/generate', { keyword_id: keyword.id }));
            } catch (err: any) {
              setError(err?.message ?? 'Could not generate a brief');
            } finally {
              setGenerating(false);
            }
          }}
        >
          {generating ? 'Building brief…' : 'Generate content brief'}
        </button>
      </div>

      {brief && <BriefBody brief={brief} />}
    </Modal>
  );
}

function BriefBody({ brief }: { brief: any }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3>{brief.title}</h3>
      <div className="row wrap">
        <Chip tone="accent">{brief.word_target} words</Chip>
        {(brief.schema_types ?? []).map((t: string) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {(brief.outline ?? []).map((section: any, i: number) => (
          <div key={i} style={{ paddingLeft: 10, borderLeft: '2px solid var(--line)' }}>
            <strong>{section.heading}</strong>
            <div className="small muted">{section.notes}</div>
          </div>
        ))}
      </div>
      {(brief.questions ?? []).length > 0 && (
        <div>
          <div className="stat-label">Questions to answer</div>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }} className="small">
            {brief.questions.map((q: string) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BriefsTab({ siteId }: { siteId: number }) {
  const briefs = useApi<ListResponse<any>>(`/content-briefs?site_id=${siteId}`, [siteId]);
  const [open, setOpen] = useState<any>(null);
  const items = briefs.data?.items ?? [];

  return (
    <Card title="Content briefs" padded={false}>
      {items.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Title</th><th>Status</th><th className="right">Target</th><th className="right">Created</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((brief) => (
                <tr key={brief.id}>
                  <td>
                    <button
                      onClick={() => setOpen(brief)}
                      style={{ background: 'none', border: 'none', font: 'inherit', color: 'var(--accent-ink)', cursor: 'pointer', padding: 0 }}
                    >
                      {brief.title}
                    </button>
                  </td>
                  <td>
                    <select
                      value={brief.status}
                      onChange={async (e) => {
                        await api.patch(`/content-briefs/${brief.id}`, { status: e.target.value });
                        void briefs.reload();
                      }}
                      style={{ width: 120 }}
                    >
                      {['idea', 'drafting', 'review', 'published'].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="right">{num(brief.word_target)}</td>
                  <td className="right small muted">{formatDate(brief.created_at)}</td>
                  <td className="right">
                    <ConfirmButton
                      onConfirm={async () => {
                        await api.del(`/content-briefs/${brief.id}`);
                        void briefs.reload();
                      }}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="✎" title="No briefs yet" hint="Generate one from a keyword on the Keywords tab." />
      )}

      {open && (
        <Modal title="Content brief" wide onClose={() => setOpen(null)}>
          <BriefBody brief={open} />
        </Modal>
      )}
    </Card>
  );
}

// --------------------------------------------------------- search console ---
type GscQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  position_delta: number | null;
  clicks_delta: number | null;
};

type Opportunity = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  kind: string;
  reason: string;
};

const OPPORTUNITY_LABEL: Record<string, string> = {
  striking_distance: 'Page two — closest wins',
  push_to_top3: 'Push into the top 3',
  low_ctr: 'Rewrite title & description',
  rising: 'Rising',
};

function SearchConsoleTab({ siteId }: { siteId: number }) {
  const status = useApi<{ connected: boolean; sites: any[] }>('/gsc/status');
  const site = useApi<any>(`/seo-sites/${siteId}`, [siteId]);
  const summary = useApi<any>(`/seo-sites/${siteId}/gsc/summary`, [siteId]);
  const queries = useApi<{ sync: any; items: GscQuery[] }>(
    `/seo-sites/${siteId}/gsc/queries?limit=300`,
    [siteId]
  );
  const opps = useApi<{ items: Opportunity[] }>(`/seo-sites/${siteId}/gsc/opportunities`, [siteId]);

  const [properties, setProperties] = useState<any[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<'opportunities' | 'queries'>('opportunities');

  const reloadAll = () => {
    void site.reload();
    void summary.reload();
    void queries.reload();
    void opps.reload();
  };

  if (!status.data) return <div className="muted">Loading…</div>;

  if (!status.data.connected) {
    return (
      <Card>
        <Empty
          icon="◎"
          title="Google Search Console is not connected"
          hint={
            <>
              This is where "which keywords do I rank for?" gets answered — with Google's own data,
              not an estimate. Add a Google app under{' '}
              <a href="/settings">Settings → Social network apps</a>, then click Connect.
            </>
          }
        />
      </Card>
    );
  }

  const property = site.data?.gsc_property;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {error && <Banner tone="error">{error}</Banner>}

      <Card title="Property">
        <div className="row wrap">
          {property ? (
            <>
              <Chip tone="good">{property}</Chip>
              <button
                className="btn sm primary"
                disabled={busy === 'sync'}
                onClick={async () => {
                  setBusy('sync');
                  setError('');
                  try {
                    await api.post(`/seo-sites/${siteId}/gsc/sync`, { days: 28 });
                    reloadAll();
                  } catch (err: any) {
                    setError(err?.message ?? 'Sync failed');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync last 28 days'}
              </button>
            </>
          ) : (
            <>
              <span className="small muted">No property linked yet.</span>
              <button
                className="btn sm"
                disabled={busy === 'props'}
                onClick={async () => {
                  setBusy('props');
                  setError('');
                  try {
                    const res = await api.get<{ items: any[] }>('/gsc/properties');
                    setProperties(res.items);
                  } catch (err: any) {
                    setError(err?.message ?? 'Could not list properties');
                  } finally {
                    setBusy('');
                  }
                }}
              >
                {busy === 'props' ? 'Loading…' : 'Choose property'}
              </button>
            </>
          )}
          {summary.data?.sync && (
            <span className="small muted">
              Last sync {formatDateTime(summary.data.sync.started_at)} ·{' '}
              {summary.data.sync.date_start} to {summary.data.sync.date_end}
            </span>
          )}
        </div>

        {properties && (
          <div className="stack" style={{ marginTop: 10 }}>
            {properties.length ? (
              properties.map((p) => (
                <button
                  key={p.siteUrl}
                  className="btn sm"
                  onClick={async () => {
                    await api.post(`/seo-sites/${siteId}/gsc/link`, { property: p.siteUrl });
                    setProperties(null);
                    reloadAll();
                  }}
                >
                  {p.siteUrl} <span className="muted">({p.permissionLevel})</span>
                </button>
              ))
            ) : (
              <span className="small muted">
                No verified properties on this Google account.
              </span>
            )}
          </div>
        )}
      </Card>

      {!summary.data ? (
        <Card>
          <Empty icon="◎" title="No Search Console data yet" hint="Link a property and run a sync." />
        </Card>
      ) : (
        <>
          <div className="grid cols-4">
            <Card><Stat label="Clicks" value={num(summary.data.totals.clicks)} sub="last 28 days" /></Card>
            <Card><Stat label="Impressions" value={num(summary.data.totals.impressions)} /></Card>
            <Card>
              <Stat label="Average CTR" value={`${(summary.data.totals.ctr * 100).toFixed(1)}%`} />
            </Card>
            <Card>
              <Stat
                label="Ranking for"
                value={num(summary.data.totals.queries)}
                sub={`avg position ${summary.data.totals.avg_position}`}
              />
            </Card>
          </div>

          <Card title="Where you rank">
            <RankedBars
              items={[
                { label: 'Positions 1–3', value: summary.data.buckets.top3 ?? 0 },
                { label: 'Positions 4–10', value: summary.data.buckets.top10 ?? 0 },
                { label: 'Page two (11–20)', value: summary.data.buckets.page2 ?? 0 },
                { label: 'Beyond 20', value: summary.data.buckets.beyond ?? 0 },
              ]}
              format={(v) => `${v} queries`}
            />
          </Card>

          <Tabs
            tabs={[
              { id: 'opportunities', label: 'Opportunities', count: opps.data?.items.length },
              { id: 'queries', label: 'All queries', count: queries.data?.items.length },
            ]}
            active={view}
            onChange={setView}
          />

          {view === 'opportunities' ? (
            <Card
              title="Highest-leverage work"
              actions={<span className="small muted">Derived from your own Search Console data</span>}
              padded={false}
            >
              {opps.data?.items.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Query</th><th>What to do</th>
                        <th className="right">Position</th><th className="right">Impressions</th><th className="right">Clicks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opps.data.items.map((o) => (
                        <tr key={o.query}>
                          <td>{o.query}</td>
                          <td>
                            <Chip tone={o.kind === 'striking_distance' ? 'accent' : ''}>
                              {OPPORTUNITY_LABEL[o.kind] ?? o.kind}
                            </Chip>
                            <div className="small muted" style={{ maxWidth: 420 }}>{o.reason}</div>
                          </td>
                          <td className="right">{o.position.toFixed(1)}</td>
                          <td className="right">{num(o.impressions)}</td>
                          <td className="right">{num(o.clicks)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty icon="✓" title="No obvious quick wins" hint="Sync again after a few weeks of data." />
              )}
            </Card>
          ) : (
            <Card
              title="Queries you rank for"
              actions={
                <button
                  className="btn sm"
                  disabled={!selected.length}
                  onClick={async () => {
                    const res = await api.post<{ imported: number }>(
                      `/seo-sites/${siteId}/gsc/import-keywords`,
                      { queries: selected }
                    );
                    setSelected([]);
                    setError('');
                    alert(`Imported ${res.imported} keyword(s) for rank tracking.`);
                  }}
                >
                  Track selected ({selected.length})
                </button>
              }
              padded={false}
            >
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th></th><th>Query</th>
                      <th className="right">Clicks</th><th className="right">Impressions</th>
                      <th className="right">CTR</th><th className="right">Position</th><th className="right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(queries.data?.items ?? []).map((q) => (
                      <tr key={q.query}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.includes(q.query)}
                            onChange={(e) =>
                              setSelected((prev) =>
                                e.target.checked ? [...prev, q.query] : prev.filter((s) => s !== q.query)
                              )
                            }
                          />
                        </td>
                        <td>{q.query}</td>
                        <td className="right">{num(q.clicks)}</td>
                        <td className="right">{num(q.impressions)}</td>
                        <td className="right">{(q.ctr * 100).toFixed(1)}%</td>
                        <td className="right">{q.position.toFixed(1)}</td>
                        <td className="right">
                          {q.position_delta === null ? (
                            <span className="muted">—</span>
                          ) : q.position_delta === 0 ? (
                            <span className="muted">0</span>
                          ) : (
                            <span className={q.position_delta > 0 ? 'pos' : 'neg'}>
                              {q.position_delta > 0 ? '▲' : '▼'} {Math.abs(q.position_delta)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------- keyword ideas --
function IdeasTab({ siteId }: { siteId: number }) {
  const [seed, setSeed] = useState('');
  const [deep, setDeep] = useState(false);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const generate = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ ideas: string[] }>('/keyword-ideas', {
        seed,
        site_id: siteId,
        deep,
      });
      setIdeas(res.ideas);
      if (!res.ideas.length) setError('No suggestions came back for that seed.');
    } catch (err: any) {
      setError(err?.message ?? 'Could not fetch ideas');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Keyword ideas">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Seed keyword">
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && seed.trim() && generate()}
              placeholder="espresso machine"
              style={{ width: 260 }}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
            Deep (slower, many more ideas)
          </label>
          <button className="btn primary" disabled={busy || !seed.trim()} onClick={generate}>
            {busy ? 'Searching…' : 'Get ideas'}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Real phrasings pulled from Google autocomplete. These are the words people actually type —
          but there are no search volumes here, because that number comes from paid datasets.
        </p>
        {error && <Banner tone="error">{error}</Banner>}
      </Card>

      {ideas.length > 0 && (
        <Card
          title={`${ideas.length} ideas`}
          actions={
            <button
              className="btn sm"
              disabled={!selected.length}
              onClick={async () => {
                let imported = 0;
                for (const idea of selected) {
                  try {
                    await api.post('/seo-keywords', { site_id: siteId, keyword: idea });
                    imported += 1;
                  } catch {
                    /* already tracked */
                  }
                }
                setSelected([]);
                alert(`Added ${imported} keyword(s) to tracking.`);
              }}
            >
              Track selected ({selected.length})
            </button>
          }
        >
          <div className="row wrap" style={{ gap: 6 }}>
            {ideas.map((idea) => {
              const on = selected.includes(idea);
              return (
                <button
                  key={idea}
                  className={`btn sm ${on ? 'primary' : ''}`}
                  onClick={() =>
                    setSelected((prev) => (on ? prev.filter((s) => s !== idea) : [...prev, idea]))
                  }
                >
                  {idea}
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
