import { config } from '../../config.js';
import { get, run } from '../../db.js';
import { decryptJson } from '../../lib/crypto.js';

/**
 * Domain authority.
 *
 * There is no way to compute Moz's Domain Authority or Ahrefs' Domain Rating
 * locally: both are derived from a proprietary crawl of the web's link graph,
 * which is the actual product those companies sell. What can be done is to read
 * a third party's score through an API.
 *
 * Open PageRank is used here because it has a genuinely free tier. It is a
 * different number from DA - derived from Common Crawl link data on a 0-10
 * scale - so it is labelled as what it is rather than dressed up as DA.
 */
export type AuthorityResult = {
  source: string;
  /** Normalised 0-100 so it can sit beside other scores in the UI. */
  score: number | null;
  /** The provider's own raw figure and scale. */
  raw: number | null;
  scale: string;
  rank: number | null;
  checked_at: string;
};

function credentials(service: string): Record<string, string> | null {
  const row = get<{ data_enc: string }>(
    'SELECT data_enc FROM credentials WHERE service = ? ORDER BY id DESC LIMIT 1',
    [service]
  );
  if (!row) return null;
  try {
    return decryptJson<Record<string, string>>(row.data_enc);
  } catch {
    return null;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

export async function fetchAuthority(siteUrl: string): Promise<AuthorityResult> {
  const creds = credentials('openpagerank');
  if (!creds?.api_key) {
    throw new Error(
      'No authority provider configured. Add an Open PageRank API key in Settings (their free tier covers personal use).'
    );
  }

  const domain = domainOf(siteUrl);
  const url = `https://openpagerank.com/api/v1.0/getPageRank?domains%5B%5D=${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    headers: { 'API-OPR': creds.api_key, 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Open PageRank returned ${res.status}`);

  const json: any = await res.json();
  const entry = json?.response?.[0];
  if (!entry || entry.status_code !== 200) {
    throw new Error(`No authority data for ${domain}. It may be too new or too small to be indexed.`);
  }

  const raw = Number(entry.page_rank_decimal);
  return {
    source: 'Open PageRank',
    // The 0-10 scale maps onto 0-100 for display alongside the other scores.
    score: Number.isFinite(raw) ? Math.round(raw * 10) : null,
    raw: Number.isFinite(raw) ? raw : null,
    scale: '0-10',
    rank: entry.rank ? Number(entry.rank) : null,
    checked_at: new Date().toISOString(),
  };
}

export async function refreshAuthority(siteId: number): Promise<AuthorityResult> {
  const site = get<any>('SELECT * FROM seo_sites WHERE id = ?', [siteId]);
  if (!site) throw new Error('Site not found');
  const result = await fetchAuthority(site.base_url);
  run('UPDATE seo_sites SET authority_json = ? WHERE id = ?', [JSON.stringify(result), siteId]);
  return result;
}
