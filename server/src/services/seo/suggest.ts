import { config } from '../../config.js';
import { all, run } from '../../db.js';

/**
 * Keyword ideas from Google's autocomplete endpoint.
 *
 * This is not a volume database - it cannot tell you how many people search a
 * term, because that number comes from Google Ads and clickstream panels that
 * Semrush and Ahrefs pay for. What it does give, free and unmetered, is the
 * real phrasing people use, which is the half of keyword research that actually
 * shapes content.
 */
const ENDPOINT = 'https://suggestqueries.google.com/complete/search';

/** Modifier patterns that pull long-tail and intent-bearing variants out. */
const PATTERNS = [
  (s: string) => s,
  (s: string) => `how to ${s}`,
  (s: string) => `what is ${s}`,
  (s: string) => `why ${s}`,
  (s: string) => `best ${s}`,
  (s: string) => `${s} vs`,
  (s: string) => `${s} cost`,
  (s: string) => `${s} near me`,
  (s: string) => `${s} for`,
  (s: string) => `${s} without`,
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * The endpoint answers `[term, [suggestions], ...]`, sometimes served as
 * text/javascript rather than JSON, so the body is parsed here rather than via
 * res.json(). Kept separate from the request so it can be unit tested.
 */
export function parseSuggestResponse(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.[1])) return [];
    return parsed[1].filter((s: unknown): s is string => typeof s === 'string' && s.trim() !== '');
  } catch {
    return [];
  }
}

export function buildSuggestUrl(term: string, country: string): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set('client', 'firefox');
  url.searchParams.set('q', term);
  url.searchParams.set('gl', country);
  return url.toString();
}

type SuggestOutcome = { ideas: string[]; error?: string };

async function suggestOnce(term: string, country: string): Promise<SuggestOutcome> {
  try {
    const res = await fetch(buildSuggestUrl(term, country), {
      headers: { 'user-agent': config.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ideas: [], error: `HTTP ${res.status}` };
    return { ideas: parseSuggestResponse(await res.text()) };
  } catch (err: any) {
    return { ideas: [], error: err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err) };
  }
}

/** Run a batch with limited concurrency so we stay a polite client. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    if (i + size < items.length) await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

export type IdeaGroup = { pattern: string; ideas: string[] };

export async function keywordIdeas(
  seed: string,
  opts: { country?: string; deep?: boolean } = {}
): Promise<{ ideas: string[]; groups: IdeaGroup[] }> {
  const country = opts.country ?? 'us';
  const term = seed.trim().toLowerCase();
  if (!term) return { ideas: [], groups: [] };

  const terms = PATTERNS.map((p) => p(term));
  // "Deep" mode appends each letter of the alphabet, the classic trick for
  // pulling a much wider set of real queries out of autocomplete.
  if (opts.deep) terms.push(...ALPHABET.map((letter) => `${term} ${letter}`));

  const results = await inBatches(terms, 5, async (t) => {
    const outcome = await suggestOnce(t, country);
    return { pattern: t, ideas: outcome.ideas, error: outcome.error };
  });

  const seen = new Set<string>();
  const ideas: string[] = [];
  for (const group of results) {
    for (const idea of group.ideas) {
      const key = idea.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ideas.push(idea);
    }
  }

  // Every request failing means the endpoint is unreachable - a blocked egress
  // or no connectivity. Say so, rather than returning an empty list that looks
  // like "there are no ideas for this term".
  if (!ideas.length) {
    const errors = results.map((r) => r.error).filter(Boolean);
    if (errors.length === results.length) {
      throw new Error(
        `Could not reach Google autocomplete (${errors[0]}). Check this machine's internet access or any firewall between it and google.com.`
      );
    }
  }

  return { ideas, groups: results.filter((g) => g.ideas.length) };
}

export function cacheIdeas(siteId: number | null, seed: string, ideas: string[]) {
  for (const idea of ideas) {
    run(
      `INSERT OR IGNORE INTO keyword_ideas (site_id, seed, idea, source) VALUES (?, ?, ?, 'autocomplete')`,
      [siteId, seed, idea]
    );
  }
}

export function cachedIdeas(siteId: number | null, seed?: string) {
  if (seed) {
    return all<any>(
      'SELECT * FROM keyword_ideas WHERE site_id IS ? AND seed = ? ORDER BY idea',
      [siteId, seed]
    );
  }
  return all<any>('SELECT * FROM keyword_ideas WHERE site_id IS ? ORDER BY created_at DESC LIMIT 500', [
    siteId,
  ]);
}
