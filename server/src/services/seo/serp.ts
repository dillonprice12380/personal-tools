import { all, get, getSetting, run } from '../../db.js';
import { config } from '../../config.js';
import { decryptJson } from '../../lib/crypto.js';

export type RankResult = {
  position: number | null;
  url: string;
  features: string[];
  aiOverview: boolean;
};

/** Credentials for rank checking live under the `serp` service. */
function serpCreds(): Record<string, string> {
  const row = get<{ data_enc: string }>(
    `SELECT data_enc FROM credentials WHERE service = 'serp' ORDER BY id DESC LIMIT 1`
  );
  if (!row) return {};
  try {
    return decryptJson<Record<string, string>>(row.data_enc);
  } catch {
    return {};
  }
}

export function serpProviderId(): string {
  return getSetting<string>('seoSerpProvider', 'manual');
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function matchRank(
  results: Array<{ link?: string; position?: number }>,
  domain: string
): { position: number | null; url: string } {
  const target = domainOf(domain);
  for (let i = 0; i < results.length; i += 1) {
    const link = results[i]?.link ?? '';
    if (link && domainOf(link) === target) {
      return { position: results[i]?.position ?? i + 1, url: link };
    }
  }
  return { position: null, url: '' };
}

async function serpapi(keyword: string, domain: string, country: string, device: string): Promise<RankResult> {
  const creds = serpCreds();
  if (!creds.api_key) throw new Error('SerpApi needs an `api_key` credential (service: serp)');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', keyword);
  url.searchParams.set('gl', country);
  url.searchParams.set('device', device);
  url.searchParams.set('num', '100');
  url.searchParams.set('api_key', creds.api_key);

  const res = await fetch(url, { headers: { 'user-agent': config.userAgent } });
  if (!res.ok) throw new Error(`SerpApi returned ${res.status}`);
  const json: any = await res.json();
  const organic = (json.organic_results ?? []) as Array<{ link?: string; position?: number }>;
  const { position, url: found } = matchRank(organic, domain);

  const features: string[] = [];
  for (const key of ['answer_box', 'knowledge_graph', 'related_questions', 'ai_overview', 'local_results']) {
    if (json[key]) features.push(key);
  }
  const aiOverview = !!json.ai_overview;
  return { position, url: found, features, aiOverview };
}

async function serper(keyword: string, domain: string, country: string, device: string): Promise<RankResult> {
  const creds = serpCreds();
  if (!creds.api_key) throw new Error('Serper needs an `api_key` credential (service: serp)');
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': creds.api_key,
      'content-type': 'application/json',
      'user-agent': config.userAgent,
    },
    body: JSON.stringify({ q: keyword, gl: country, num: 100, device }),
  });
  if (!res.ok) throw new Error(`Serper returned ${res.status}`);
  const json: any = await res.json();
  const organic = (json.organic ?? []) as Array<{ link?: string; position?: number }>;
  const { position, url: found } = matchRank(organic, domain);

  const features: string[] = [];
  for (const key of ['answerBox', 'knowledgeGraph', 'peopleAlsoAsk', 'topStories']) {
    if (json[key]) features.push(key);
  }
  return { position, url: found, features, aiOverview: !!json.answerBox };
}

export type SerpSnapshot = {
  organic: Array<{ link: string; title: string; position: number }>;
  questions: string[];
};

/**
 * Raw SERP data used for competitive brief building. Returns null when no API
 * provider is configured, so callers can fall back to templates.
 */
export async function fetchSerp(
  keyword: string,
  country = 'us',
  device = 'desktop'
): Promise<SerpSnapshot | null> {
  const provider = serpProviderId();
  const creds = serpCreds();
  if (!creds.api_key || (provider !== 'serpapi' && provider !== 'serper')) return null;

  try {
    if (provider === 'serpapi') {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', keyword);
      url.searchParams.set('gl', country);
      url.searchParams.set('device', device);
      url.searchParams.set('api_key', creds.api_key);
      const res = await fetch(url, { headers: { 'user-agent': config.userAgent } });
      if (!res.ok) return null;
      const json: any = await res.json();
      return {
        organic: (json.organic_results ?? [])
          .slice(0, 10)
          .map((r: any, i: number) => ({
            link: r.link ?? '',
            title: r.title ?? '',
            position: r.position ?? i + 1,
          })),
        questions: (json.related_questions ?? []).map((q: any) => q.question).filter(Boolean),
      };
    }
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': creds.api_key,
        'content-type': 'application/json',
        'user-agent': config.userAgent,
      },
      body: JSON.stringify({ q: keyword, gl: country, device }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      organic: (json.organic ?? []).slice(0, 10).map((r: any, i: number) => ({
        link: r.link ?? '',
        title: r.title ?? '',
        position: r.position ?? i + 1,
      })),
      questions: (json.peopleAlsoAsk ?? []).map((q: any) => q.question).filter(Boolean),
    };
  } catch {
    return null;
  }
}

export const SERP_PROVIDERS = [
  { id: 'manual', label: 'Manual entry (no API, free)', needsKey: false },
  { id: 'serpapi', label: 'SerpApi', needsKey: true },
  { id: 'serper', label: 'Serper.dev', needsKey: true },
];

/** Look up one keyword's current position. Throws when no API provider is set. */
export async function checkRank(
  keyword: string,
  domain: string,
  country = 'us',
  device = 'desktop'
): Promise<RankResult> {
  const provider = serpProviderId();
  if (provider === 'serpapi') return serpapi(keyword, domain, country, device);
  if (provider === 'serper') return serper(keyword, domain, country, device);
  throw new Error(
    'No SERP provider configured. Set one in Settings, or record positions manually.'
  );
}

/** Record a position for a keyword (idempotent per keyword/day/engine). */
export function recordRanking(
  keywordId: number,
  result: RankResult,
  engine = 'google',
  checkedOn?: string
) {
  run(
    `INSERT INTO seo_rankings (keyword_id, checked_on, engine, position, url, serp_features, ai_overview)
     VALUES (?, COALESCE(?, date('now')), ?, ?, ?, ?, ?)
     ON CONFLICT(keyword_id, checked_on, engine) DO UPDATE SET
       position = excluded.position, url = excluded.url,
       serp_features = excluded.serp_features, ai_overview = excluded.ai_overview`,
    [
      keywordId,
      checkedOn ?? null,
      engine,
      result.position,
      result.url,
      result.features.join(','),
      result.aiOverview ? 1 : 0,
    ]
  );
}

/** Keywords due for a refresh, oldest check first. */
export function keywordsToRefresh(limit = 25) {
  return all<any>(
    `SELECT k.*, s.base_url,
            (SELECT MAX(checked_on) FROM seo_rankings r WHERE r.keyword_id = k.id) AS last_checked
       FROM seo_keywords k
       JOIN seo_sites s ON s.id = k.site_id
      WHERE k.tracked = 1
        AND (last_checked IS NULL OR last_checked < date('now'))
      ORDER BY COALESCE(last_checked, '0000-00-00') ASC
      LIMIT ?`,
    [limit]
  );
}
