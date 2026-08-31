import { all, get, getSetting, logActivity, run } from '../../db.js';
import { config } from '../../config.js';
import { decryptJson, encryptJson } from '../../lib/crypto.js';
import { getOAuth2Config, needsRefresh, refreshTokens } from '../social/oauth2.js';
import { appCreds } from '../../routes/oauth.js';

/**
 * Google Search Console.
 *
 * This is the answer to "what am I actually ranking for". Semrush infers that
 * from its own SERP crawl; Search Console reports what Google itself recorded
 * for your property, including impressions and click-through rate, which no
 * third-party estimate can see. It is free, and for your own sites it is
 * strictly better data.
 */
const API = 'https://www.googleapis.com/webmasters/v3';

export type GscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** The stored Google credential, refreshed in place when it is about to expire. */
export async function googleAccessToken(): Promise<string> {
  const row = get<{ id: number; data_enc: string }>(
    `SELECT id, data_enc FROM credentials WHERE service = 'google' ORDER BY id DESC LIMIT 1`
  );
  if (!row) throw new Error('Google is not connected. Connect it in Settings first.');

  let creds: Record<string, any>;
  try {
    creds = decryptJson<Record<string, any>>(row.data_enc);
  } catch {
    throw new Error('Stored Google credential could not be decrypted (has HELM_SECRET changed?)');
  }

  if (!needsRefresh(creds)) return creds.access_token;

  if (!creds.refresh_token) {
    throw new Error('Google access expired and no refresh token is stored - reconnect Google.');
  }
  const app = appCreds('google');
  if (!app) throw new Error('No Google app configured.');

  const fresh = await refreshTokens(getOAuth2Config('google'), {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    refreshToken: creds.refresh_token,
  });
  // Google omits refresh_token on refresh responses, so merge rather than replace.
  const merged = { ...creds, ...fresh };
  run('UPDATE credentials SET data_enc = ? WHERE id = ?', [encryptJson(merged), row.id]);
  return merged.access_token;
}

async function gscFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await googleAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': config.userAgent,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? text.slice(0, 300);
    throw new Error(`Search Console ${res.status}: ${detail}`);
  }
  return json;
}

/** Properties this Google account can read. */
export async function listProperties(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const json = await gscFetch('/sites');
  return (json?.siteEntry ?? []).filter(
    (s: any) => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser'
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

/**
 * Pull one dimension of search analytics, paging until Google runs out of rows.
 * The API caps a response at 25k rows, so anything larger needs startRow paging.
 */
async function queryAnalytics(
  property: string,
  dimension: 'query' | 'page',
  startDate: string,
  endDate: string,
  maxRows: number
): Promise<GscRow[]> {
  const encoded = encodeURIComponent(property);
  const rows: GscRow[] = [];
  const pageSize = 25_000;

  while (rows.length < maxRows) {
    const body = {
      startDate,
      endDate,
      dimensions: [dimension],
      rowLimit: Math.min(pageSize, maxRows - rows.length),
      startRow: rows.length,
    };
    const json = await gscFetch(`/sites/${encoded}/searchAnalytics/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const batch: GscRow[] = json?.rows ?? [];
    rows.push(...batch);
    if (batch.length < body.rowLimit) break;
  }
  return rows;
}

/**
 * Sync a site's Search Console data. Each sync is a snapshot, so history is
 * preserved and week-on-week movement can be compared later.
 */
export async function syncSite(
  siteId: number,
  opts: { days?: number; maxRows?: number } = {}
): Promise<{ syncId: number; queries: number; pages: number }> {
  const site = get<any>('SELECT * FROM seo_sites WHERE id = ?', [siteId]);
  if (!site) throw new Error('Site not found');
  if (!site.gsc_property) {
    throw new Error('This site has no Search Console property linked yet.');
  }

  const days = opts.days ?? 28;
  const maxRows = opts.maxRows ?? getSetting<number>('gscMaxRows', 5000);
  // Search Console data lags by two to three days; asking for today returns nothing.
  const endDate = isoDaysAgo(3);
  const startDate = isoDaysAgo(3 + days);

  const syncId = Number(
    run(
      `INSERT INTO gsc_syncs (site_id, date_start, date_end) VALUES (?, ?, ?)`,
      [siteId, startDate, endDate]
    ).lastInsertRowid
  );

  try {
    const queries = await queryAnalytics(site.gsc_property, 'query', startDate, endDate, maxRows);
    for (const row of queries) {
      run(
        `INSERT OR IGNORE INTO gsc_queries (sync_id, site_id, query, clicks, impressions, ctr, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [syncId, siteId, row.keys[0], row.clicks, row.impressions, row.ctr, row.position]
      );
    }

    const pages = await queryAnalytics(site.gsc_property, 'page', startDate, endDate, Math.min(maxRows, 1000));
    for (const row of pages) {
      run(
        `INSERT OR IGNORE INTO gsc_pages (sync_id, site_id, page, clicks, impressions, ctr, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [syncId, siteId, row.keys[0], row.clicks, row.impressions, row.ctr, row.position]
      );
    }

    run(
      `UPDATE gsc_syncs SET status = 'done', finished_at = datetime('now'), rows_fetched = ? WHERE id = ?`,
      [queries.length + pages.length, syncId]
    );
    logActivity('seo_sites', siteId, 'gsc_sync', `${queries.length} queries from Search Console`);
    return { syncId, queries: queries.length, pages: pages.length };
  } catch (err: any) {
    run(
      `UPDATE gsc_syncs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`,
      [String(err?.message ?? err).slice(0, 500), syncId]
    );
    throw err;
  }
}

export function latestSync(siteId: number) {
  return get<any>(
    `SELECT * FROM gsc_syncs WHERE site_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`,
    [siteId]
  );
}

/** The previous completed sync, used to compute movement. */
export function previousSync(siteId: number, beforeId: number) {
  return get<any>(
    `SELECT * FROM gsc_syncs WHERE site_id = ? AND status = 'done' AND id < ?
      ORDER BY started_at DESC LIMIT 1`,
    [siteId, beforeId]
  );
}

export function queriesForSync(syncId: number, limit = 500, offset = 0) {
  return all<any>(
    `SELECT * FROM gsc_queries WHERE sync_id = ? ORDER BY impressions DESC LIMIT ? OFFSET ?`,
    [syncId, limit, offset]
  );
}

// ------------------------------------------------------------ opportunities --
export type Opportunity = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  kind: 'striking_distance' | 'push_to_top3' | 'low_ctr' | 'rising';
  reason: string;
  priority: number;
};

/**
 * Typical click-through rate by position. Used to spot queries earning far
 * fewer clicks than their ranking should produce - usually a weak title or
 * description rather than a ranking problem.
 */
function expectedCtr(position: number): number {
  if (position <= 1) return 0.28;
  if (position <= 2) return 0.15;
  if (position <= 3) return 0.11;
  if (position <= 5) return 0.07;
  if (position <= 7) return 0.04;
  if (position <= 10) return 0.025;
  if (position <= 20) return 0.01;
  return 0.005;
}

/**
 * Classify a single query into an actionable opportunity, or null.
 * Pure so the thresholds can be tested without touching the network or the DB.
 */
export function classifyOpportunity(row: {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}): Opportunity | null {
  const base = { ...row };

  // Page two with real demand: the highest-leverage work in SEO.
  if (row.position > 10 && row.position <= 20 && row.impressions >= 50) {
    return {
      ...base,
      kind: 'striking_distance',
      reason: `Ranking ${row.position.toFixed(1)} - page two. Small gains here move it onto page one.`,
      priority: row.impressions * 2,
    };
  }

  // Already on page one but below the fold.
  if (row.position > 3 && row.position <= 10 && row.impressions >= 100) {
    return {
      ...base,
      kind: 'push_to_top3',
      reason: `Position ${row.position.toFixed(1)} with ${row.impressions} impressions. Top three would multiply the clicks.`,
      priority: row.impressions * 1.5,
    };
  }

  // Ranking well but under-clicked - a snippet problem, not a ranking one.
  if (row.position <= 10 && row.impressions >= 200 && row.ctr < expectedCtr(row.position) * 0.5) {
    return {
      ...base,
      kind: 'low_ctr',
      reason: `${(row.ctr * 100).toFixed(1)}% click-through at position ${row.position.toFixed(
        1
      )} is about half what that position usually earns. Rewrite the title and description.`,
      priority: row.impressions,
    };
  }

  return null;
}

/** Opportunities from the most recent sync, best first. */
export function opportunities(siteId: number, limit = 50): Opportunity[] {
  const sync = latestSync(siteId);
  if (!sync) return [];
  const rows = all<any>(
    'SELECT query, clicks, impressions, ctr, position FROM gsc_queries WHERE sync_id = ?',
    [sync.id]
  );
  return rows
    .map(classifyOpportunity)
    .filter((o): o is Opportunity => o !== null)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/** Queries from the latest sync, with movement against the previous one. */
export function queriesWithMovement(siteId: number, limit = 200) {
  const sync = latestSync(siteId);
  if (!sync) return { sync: null, items: [] as any[] };
  const prev = previousSync(siteId, sync.id);

  const rows = all<any>(
    `SELECT q.*,
            p.position AS prev_position,
            p.clicks   AS prev_clicks
       FROM gsc_queries q
       LEFT JOIN gsc_queries p ON p.query = q.query AND p.sync_id = ?
      WHERE q.sync_id = ?
      ORDER BY q.impressions DESC
      LIMIT ?`,
    [prev?.id ?? -1, sync.id, limit]
  );

  return {
    sync,
    items: rows.map((r) => ({
      ...r,
      // A rank moving from 12 to 8 is an improvement, so the delta is inverted.
      position_delta:
        r.prev_position != null ? Math.round((r.prev_position - r.position) * 10) / 10 : null,
      clicks_delta: r.prev_clicks != null ? r.clicks - r.prev_clicks : null,
    })),
  };
}

/** Roll-up for the Search Console overview. */
export function gscSummary(siteId: number) {
  const sync = latestSync(siteId);
  if (!sync) return null;
  const totals = get<any>(
    `SELECT COUNT(*) AS queries,
            COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(impressions), 0) AS impressions,
            COALESCE(AVG(position), 0) AS avg_position
       FROM gsc_queries WHERE sync_id = ?`,
    [sync.id]
  );
  const buckets = get<any>(
    `SELECT
       SUM(CASE WHEN position <= 3 THEN 1 ELSE 0 END) AS top3,
       SUM(CASE WHEN position > 3 AND position <= 10 THEN 1 ELSE 0 END) AS top10,
       SUM(CASE WHEN position > 10 AND position <= 20 THEN 1 ELSE 0 END) AS page2,
       SUM(CASE WHEN position > 20 THEN 1 ELSE 0 END) AS beyond
     FROM gsc_queries WHERE sync_id = ?`,
    [sync.id]
  );
  return {
    sync,
    totals: {
      ...totals,
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      avg_position: Math.round(totals.avg_position * 10) / 10,
    },
    buckets,
    top_pages: all<any>(
      'SELECT page, clicks, impressions, ctr, position FROM gsc_pages WHERE sync_id = ? ORDER BY clicks DESC LIMIT 15',
      [sync.id]
    ),
  };
}
