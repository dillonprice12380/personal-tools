import { Router } from 'express';
import { all, get, run, scalar } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, parseJson, toInt, wrap } from '../lib/http.js';
import { runCrawl } from '../services/seo/crawler.js';
import {
  SERP_PROVIDERS,
  checkRank,
  recordRanking,
  serpProviderId,
} from '../services/seo/serp.js';
import { buildBrief } from '../services/seo/briefs.js';
import {
  gscSummary,
  listProperties,
  opportunities,
  queriesWithMovement,
  syncSite,
} from '../services/seo/gsc.js';
import { cacheIdeas, cachedIdeas, keywordIdeas } from '../services/seo/suggest.js';
import { refreshAuthority } from '../services/seo/authority.js';

export const seoRouter = Router();

seoRouter.get(
  '/seo-providers',
  wrap((_req, res) => res.json({ items: SERP_PROVIDERS, active: serpProviderId() }))
);

seoRouter.use(
  '/seo-sites',
  crud({
    table: 'seo_sites',
    columns: ['name', 'base_url', 'client_id', 'gsc_property'],
    required: ['name', 'base_url'],
    search: ['name', 'base_url'],
    orderBy: 'name ASC',
    describe: (r) => r?.name ?? '',
    hydrate: (row) => ({
      ...row,
      authority: parseJson<any>(row.authority_json, {}),
      keyword_count: scalar<number>('SELECT COUNT(*) FROM seo_keywords WHERE site_id = ?', [row.id], 0),
      last_crawl: get(
        `SELECT id, status, started_at, finished_at, pages_crawled, health_score
           FROM seo_crawls WHERE site_id = ? ORDER BY started_at DESC LIMIT 1`,
        [row.id]
      ),
    }),
    beforeWrite: (data) => {
      if (typeof data.base_url === 'string') {
        const trimmed = data.base_url.trim();
        data.base_url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        try {
          // Normalising here means every crawl starts from a valid origin.
          new URL(data.base_url);
        } catch {
          throw badRequest(`Not a valid URL: ${data.base_url}`);
        }
      }
    },
  })
);

/** Refresh the site's third-party authority score. */
seoRouter.post(
  '/seo-sites/:id/authority',
  wrap(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM seo_sites WHERE id = ?', [id])) throw notFound('Site');
    res.json(await refreshAuthority(id));
  })
);

// ------------------------------------------------- google search console ---
/** Whether Google is connected, and which properties it can read. */
seoRouter.get(
  '/gsc/status',
  wrap((_req, res) => {
    const connected = !!get('SELECT id FROM credentials WHERE service = ?', ['google']);
    res.json({
      connected,
      sites: all(
        `SELECT id, name, base_url, gsc_property FROM seo_sites ORDER BY name`
      ),
    });
  })
);

/** Live call to Google for the property list. */
seoRouter.get(
  '/gsc/properties',
  wrap(async (_req, res) => {
    res.json({ items: await listProperties() });
  })
);

/** Point a Helm site at one Search Console property. */
seoRouter.post(
  '/seo-sites/:id/gsc/link',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM seo_sites WHERE id = ?', [id])) throw notFound('Site');
    const property = String(req.body?.property ?? '').trim();
    run('UPDATE seo_sites SET gsc_property = ? WHERE id = ?', [property, id]);
    res.json(get('SELECT * FROM seo_sites WHERE id = ?', [id]));
  })
);

seoRouter.post(
  '/seo-sites/:id/gsc/sync',
  wrap(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM seo_sites WHERE id = ?', [id])) throw notFound('Site');
    const result = await syncSite(id, { days: toInt(req.body?.days, 28) || 28 });
    res.json({ ...result, summary: gscSummary(id) });
  })
);

seoRouter.get(
  '/seo-sites/:id/gsc/summary',
  wrap((req, res) => res.json(gscSummary(toInt(req.params.id))))
);

/** Every query the site actually ranks for, with movement since the last sync. */
seoRouter.get(
  '/seo-sites/:id/gsc/queries',
  wrap((req, res) => {
    const limit = Math.min(toInt(req.query.limit, 200) || 200, 1000);
    res.json(queriesWithMovement(toInt(req.params.id), limit));
  })
);

seoRouter.get(
  '/seo-sites/:id/gsc/opportunities',
  wrap((req, res) => {
    res.json({ items: opportunities(toInt(req.params.id), toInt(req.query.limit, 50) || 50) });
  })
);

/**
 * Promote discovered queries into tracked keywords, so rank history starts
 * accumulating for the ones worth watching.
 */
seoRouter.post(
  '/seo-sites/:id/gsc/import-keywords',
  wrap((req, res) => {
    const siteId = toInt(req.params.id);
    const queries: string[] = Array.isArray(req.body?.queries) ? req.body.queries : [];
    if (!queries.length) throw badRequest('No queries supplied');

    let imported = 0;
    let skipped = 0;
    for (const keyword of queries) {
      const term = String(keyword).trim();
      if (!term) continue;
      const existing = get('SELECT id FROM seo_keywords WHERE site_id = ? AND keyword = ?', [
        siteId,
        term,
      ]);
      if (existing) {
        skipped += 1;
        continue;
      }
      run(
        `INSERT INTO seo_keywords (site_id, keyword, source, target_url)
         VALUES (?, ?, 'search_console', '')`,
        [siteId, term]
      );
      imported += 1;
    }
    res.json({ imported, skipped });
  })
);

// -------------------------------------------------------- keyword ideas ----
seoRouter.post(
  '/keyword-ideas',
  wrap(async (req, res) => {
    const seed = String(req.body?.seed ?? '').trim();
    if (!seed) throw badRequest('A seed keyword is required');
    const siteId = req.body?.site_id ? toInt(req.body.site_id) : null;
    const result = await keywordIdeas(seed, {
      country: req.body?.country ?? 'us',
      deep: !!req.body?.deep,
    });
    if (siteId) cacheIdeas(siteId, seed, result.ideas);
    res.json({ seed, count: result.ideas.length, ...result });
  })
);

seoRouter.get(
  '/keyword-ideas',
  wrap((req, res) => {
    const siteId = req.query.site_id ? toInt(req.query.site_id) : null;
    res.json({ items: cachedIdeas(siteId, req.query.seed ? String(req.query.seed) : undefined) });
  })
);

// --------------------------------------------------------------- crawls ----
/** Kick off a crawl. Runs in the background; poll the crawl row for progress. */
seoRouter.post(
  '/seo-sites/:id/crawl',
  wrap((req, res) => {
    const siteId = toInt(req.params.id);
    const site = get<any>('SELECT * FROM seo_sites WHERE id = ?', [siteId]);
    if (!site) throw notFound('Site');
    const running = get(
      `SELECT id FROM seo_crawls WHERE site_id = ? AND status = 'running'`,
      [siteId]
    );
    if (running) throw badRequest('A crawl is already running for this site');

    const maxPages = Math.min(Math.max(toInt(req.body?.max_pages, 50), 1), 500);
    const info = run('INSERT INTO seo_crawls (site_id, max_pages) VALUES (?, ?)', [siteId, maxPages]);
    const crawlId = Number(info.lastInsertRowid);

    void runCrawl(crawlId).catch((err) => {
      run(`UPDATE seo_crawls SET status = 'failed', error = ? WHERE id = ?`, [
        String(err?.message ?? err).slice(0, 500),
        crawlId,
      ]);
    });

    res.status(202).json(get('SELECT * FROM seo_crawls WHERE id = ?', [crawlId]));
  })
);

seoRouter.use(
  '/seo-crawls',
  crud({
    table: 'seo_crawls',
    columns: ['site_id', 'max_pages'],
    filters: ['site_id', 'status'],
    orderBy: 'started_at DESC',
    disable: ['create'],
    hydrate: (row) => ({ ...row, site_checks: parseJson(row.site_checks_json, {}) }),
  })
);

/** Crawl report: issue counts, worst pages, AEO distribution. */
seoRouter.get(
  '/seo-crawls/:id/report',
  wrap((req, res) => {
    const crawlId = toInt(req.params.id);
    const crawl = get<any>('SELECT * FROM seo_crawls WHERE id = ?', [crawlId]);
    if (!crawl) throw notFound('Crawl');

    const pages = all<any>('SELECT * FROM seo_pages WHERE crawl_id = ?', [crawlId]);
    const counts = new Map<string, { code: string; severity: string; message: string; count: number }>();
    for (const page of pages) {
      for (const issue of parseJson<any[]>(page.issues_json, [])) {
        const entry = counts.get(issue.code) ?? { ...issue, count: 0 };
        entry.count += 1;
        counts.set(issue.code, entry);
      }
    }
    const severityRank: Record<string, number> = { critical: 0, warning: 1, notice: 2 };
    const issues = [...counts.values()].sort(
      (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count
    );

    const withIssueCount = pages
      .map((p) => ({
        id: p.id,
        url: p.url,
        status_code: p.status_code,
        title: p.title,
        word_count: p.word_count,
        aeo_score: p.aeo_score,
        issue_count: parseJson<any[]>(p.issues_json, []).length,
      }))
      .sort((a, b) => b.issue_count - a.issue_count);

    res.json({
      crawl: { ...crawl, site_checks: parseJson(crawl.site_checks_json, {}) },
      issues,
      pages: withIssueCount,
      totals: {
        pages: pages.length,
        avg_aeo: pages.length
          ? Math.round(pages.reduce((sum, p) => sum + p.aeo_score, 0) / pages.length)
          : 0,
        avg_words: pages.length
          ? Math.round(pages.reduce((sum, p) => sum + p.word_count, 0) / pages.length)
          : 0,
        critical: issues.filter((i) => i.severity === 'critical').reduce((s, i) => s + i.count, 0),
        warnings: issues.filter((i) => i.severity === 'warning').reduce((s, i) => s + i.count, 0),
      },
    });
  })
);

seoRouter.use(
  '/seo-pages',
  crud({
    table: 'seo_pages',
    columns: [],
    filters: ['crawl_id', 'status_code'],
    search: ['url', 'title'],
    orderBy: 'aeo_score ASC, id ASC',
    sortable: ['aeo_score', 'word_count', 'load_ms', 'status_code', 'url', 'id'],
    disable: ['create', 'update'],
    hydrate: (row) => ({
      ...row,
      issues: parseJson<any[]>(row.issues_json, []),
      aeo: parseJson<any>(row.aeo_json, {}),
    }),
  })
);

// ------------------------------------------------------------- keywords ----
function rankHistory(keywordId: number, limit = 90) {
  return all(
    `SELECT checked_on, position, url, ai_overview, serp_features
       FROM seo_rankings WHERE keyword_id = ?
      ORDER BY checked_on DESC LIMIT ?`,
    [keywordId, limit]
  );
}

function hydrateKeyword(row: any) {
  const history = rankHistory(row.id, 60) as any[];
  const latest = history[0] ?? null;
  const prior = history.find((h) => h.checked_on < (latest?.checked_on ?? '')) ?? null;
  // A rank going from 12 to 8 is an improvement, so the delta is inverted.
  const delta =
    latest?.position && prior?.position ? prior.position - latest.position : null;
  return {
    ...row,
    latest_position: latest?.position ?? null,
    latest_checked: latest?.checked_on ?? null,
    latest_url: latest?.url ?? '',
    ai_overview: !!latest?.ai_overview,
    delta,
    history: history.slice(0, 30).reverse(),
  };
}

seoRouter.use(
  '/seo-keywords',
  crud({
    table: 'seo_keywords',
    columns: [
      'site_id',
      'keyword',
      'country',
      'device',
      'intent',
      'volume',
      'difficulty',
      'cpc_cents',
      'target_url',
      'tracked',
    ],
    required: ['site_id', 'keyword'],
    filters: ['site_id', 'tracked', 'intent'],
    search: ['keyword', 'target_url'],
    orderBy: 'keyword ASC',
    sortable: ['keyword', 'volume', 'difficulty', 'id'],
    describe: (r) => r?.keyword ?? '',
    hydrate: hydrateKeyword,
  })
);

seoRouter.get(
  '/seo-keywords/:id/history',
  wrap((req, res) => res.json({ items: rankHistory(toInt(req.params.id)) }))
);

/** Manual position entry - the zero-cost alternative to a SERP API. */
seoRouter.post(
  '/seo-keywords/:id/rankings',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const keyword = get<any>('SELECT * FROM seo_keywords WHERE id = ?', [id]);
    if (!keyword) throw notFound('Keyword');
    const position = req.body?.position === null || req.body?.position === ''
      ? null
      : toInt(req.body?.position);
    recordRanking(
      id,
      {
        position,
        url: req.body?.url ?? '',
        features: Array.isArray(req.body?.features) ? req.body.features : [],
        aiOverview: !!req.body?.ai_overview,
      },
      req.body?.engine ?? 'google',
      req.body?.checked_on
    );
    res.status(201).json(hydrateKeyword(get('SELECT * FROM seo_keywords WHERE id = ?', [id])));
  })
);

/** Live rank check through the configured SERP provider. */
seoRouter.post(
  '/seo-keywords/:id/check',
  wrap(async (req, res) => {
    const id = toInt(req.params.id);
    const keyword = get<any>(
      `SELECT k.*, s.base_url FROM seo_keywords k
         JOIN seo_sites s ON s.id = k.site_id WHERE k.id = ?`,
      [id]
    );
    if (!keyword) throw notFound('Keyword');
    const result = await checkRank(
      keyword.keyword,
      keyword.target_url || keyword.base_url,
      keyword.country,
      keyword.device
    );
    recordRanking(id, result);
    res.json({ result, keyword: hydrateKeyword(get('SELECT * FROM seo_keywords WHERE id = ?', [id])) });
  })
);

seoRouter.use(
  '/seo-competitors',
  crud({
    table: 'seo_competitors',
    columns: ['site_id', 'domain', 'label'],
    required: ['site_id', 'domain'],
    filters: ['site_id'],
    orderBy: 'domain ASC',
  })
);

// -------------------------------------------------------- content briefs ---
seoRouter.use(
  '/content-briefs',
  crud({
    table: 'content_briefs',
    columns: [
      'site_id',
      'keyword_id',
      'title',
      'target_url',
      'outline_json',
      'questions_json',
      'word_target',
      'status',
      'task_id',
    ],
    required: ['site_id'],
    filters: ['site_id', 'status', 'keyword_id'],
    search: ['title'],
    orderBy: 'created_at DESC',
    describe: (r) => r?.title ?? '',
    hydrate: (row) => ({
      ...row,
      outline: parseJson<any[]>(row.outline_json, []),
      questions: parseJson<string[]>(row.questions_json, []),
    }),
    beforeWrite: (data) => {
      for (const key of ['outline_json', 'questions_json']) {
        if (data[key] && typeof data[key] !== 'string') data[key] = JSON.stringify(data[key]);
      }
    },
  })
);

/**
 * Draft an AEO-shaped brief for a keyword: a direct-answer opening, question
 * headings, an FAQ, and the schema types to mark it up with.
 */
seoRouter.post(
  '/content-briefs/generate',
  wrap(async (req, res) => {
    const keywordId = toInt(req.body?.keyword_id);
    const keyword = get<any>('SELECT * FROM seo_keywords WHERE id = ?', [keywordId]);
    if (!keyword) throw notFound('Keyword');
    const brief = await buildBrief(keyword);
    const info = run(
      `INSERT INTO content_briefs (site_id, keyword_id, title, target_url, outline_json, questions_json, word_target)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        keyword.site_id,
        keyword.id,
        brief.title,
        keyword.target_url ?? '',
        JSON.stringify(brief.outline),
        JSON.stringify(brief.questions),
        brief.wordTarget,
      ]
    );
    const row = get<any>('SELECT * FROM content_briefs WHERE id = ?', [Number(info.lastInsertRowid)]);
    res.status(201).json({
      ...row,
      outline: brief.outline,
      questions: brief.questions,
      schema_types: brief.schemaTypes,
    });
  })
);

/** SEO home screen: crawl health, rank movement, keyword distribution. */
seoRouter.get(
  '/seo-overview',
  wrap((req, res) => {
    const siteId = toInt(req.query.site_id);
    if (!siteId) throw badRequest('site_id is required');
    const site = get<any>('SELECT * FROM seo_sites WHERE id = ?', [siteId]);
    if (!site) throw notFound('Site');

    const lastCrawl = get<any>(
      `SELECT * FROM seo_crawls WHERE site_id = ? AND status = 'done'
        ORDER BY started_at DESC LIMIT 1`,
      [siteId]
    );
    const keywords = all<any>('SELECT * FROM seo_keywords WHERE site_id = ?', [siteId]).map(
      hydrateKeyword
    );
    const ranked = keywords.filter((k) => k.latest_position !== null);

    const buckets = { top3: 0, top10: 0, top20: 0, top50: 0, beyond: 0, unranked: 0 };
    for (const kw of keywords) {
      const pos = kw.latest_position;
      if (pos === null) buckets.unranked += 1;
      else if (pos <= 3) buckets.top3 += 1;
      else if (pos <= 10) buckets.top10 += 1;
      else if (pos <= 20) buckets.top20 += 1;
      else if (pos <= 50) buckets.top50 += 1;
      else buckets.beyond += 1;
    }

    // Where ranking data could come from, so the UI can explain an empty
    // report instead of showing a wall of zeroes.
    const gscConnected = !!get('SELECT id FROM credentials WHERE service = ?', ['google']);
    const gscSynced = !!get(
      `SELECT id FROM gsc_syncs WHERE site_id = ? AND status = 'done' LIMIT 1`,
      [siteId]
    );
    const anyRankings = !!get(
      `SELECT r.id FROM seo_rankings r
         JOIN seo_keywords k ON k.id = r.keyword_id
        WHERE k.site_id = ? LIMIT 1`,
      [siteId]
    );

    res.json({
      site,
      sources: {
        gsc_connected: gscConnected,
        gsc_linked: !!site.gsc_property,
        gsc_synced: gscSynced,
        serp_provider: serpProviderId(),
        has_rankings: anyRankings,
        // Nothing anywhere can report a position for this site yet.
        none_configured: !gscSynced && !anyRankings && serpProviderId() === 'manual',
      },
      crawl: lastCrawl
        ? { ...lastCrawl, site_checks: parseJson(lastCrawl.site_checks_json, {}) }
        : null,
      keywords: {
        total: keywords.length,
        tracked: keywords.filter((k) => k.tracked).length,
        ranked: ranked.length,
        ai_overviews: keywords.filter((k) => k.ai_overview).length,
        avg_position: ranked.length
          ? Math.round((ranked.reduce((s, k) => s + k.latest_position, 0) / ranked.length) * 10) / 10
          : null,
        buckets,
        improving: keywords.filter((k) => (k.delta ?? 0) > 0).length,
        declining: keywords.filter((k) => (k.delta ?? 0) < 0).length,
      },
      movers: keywords
        .filter((k) => k.delta !== null && k.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 10),
      briefs: all(
        `SELECT id, title, status, created_at FROM content_briefs
          WHERE site_id = ? ORDER BY created_at DESC LIMIT 10`,
        [siteId]
      ),
    });
  })
);
