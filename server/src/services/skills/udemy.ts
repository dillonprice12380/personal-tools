/**
 * Udemy catalogue + affiliate link handling.
 *
 * Two things live here, deliberately separate:
 *
 *   1. Fetching course metadata from Udemy's Affiliate API. This needs
 *      credentials Udemy issues to approved affiliates, and it is optional -
 *      without it you paste course URLs and the catalogue still works.
 *   2. Turning a plain course URL into your tracked link. This never needs the
 *      API, works for every network, and is what actually earns.
 *
 * Udemy runs its affiliate programme through a network (Impact at the time of
 * writing; Rakuten/LinkSynergy historically), and the exact deep-link shape is
 * whatever your own dashboard gives you. Rather than hardcode one vendor's URL
 * format and quietly break when it changes, Helm stores the link base you were
 * issued and appends the destination to it. `custom` covers anything not
 * described below.
 */
import { config } from '../../config.js';

export type AffiliateNetwork = 'none' | 'direct' | 'linksynergy' | 'impact' | 'custom';

export type AffiliateConfig = {
  network: AffiliateNetwork;
  /** Rakuten/LinkSynergy publisher id. */
  publisherId: string;
  /** Rakuten/LinkSynergy merchant id (`mid`). Udemy's is commonly 39197 - confirm in your dashboard. */
  advertiserId: string;
  /** Impact: the deep-link base copied out of the Impact dashboard. */
  linkBase: string;
  /** custom: a template using {url} and/or {encoded_url}. */
  template: string;
  /** Extra query params added to the Udemy URL itself, e.g. `utm_source=helm`. */
  extraParams: string;
  /** Shown next to every affiliate link in the UI. Required by the FTC, and by Udemy's own terms. */
  disclosure: string;
};

export const AFFILIATE_DEFAULTS: AffiliateConfig = {
  network: 'none',
  publisherId: '',
  advertiserId: '39197',
  linkBase: '',
  template: '',
  extraParams: '',
  disclosure: 'Contains affiliate links. Helm may earn a commission on purchases made through them.',
};

export const UDEMY_HOSTS = ['udemy.com', 'www.udemy.com'];

/**
 * Accept only an absolute http(s) URL.
 *
 * The redirect endpoint sends a browser wherever the stored row points, so a
 * `javascript:` or `data:` URL that reached the database through an import
 * must never make it back out as a Location header.
 */
export function safeOutboundUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Normalise a Udemy course URL, rejecting anything not actually on Udemy. */
export function normaliseUdemyUrl(raw: string): string | null {
  const safe = safeOutboundUrl(raw.trim());
  if (!safe) return null;
  const url = new URL(safe);
  if (!UDEMY_HOSTS.includes(url.hostname.toLowerCase())) return null;
  // Tracking params from wherever the link was copied would otherwise ride
  // along and compete with our own.
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** The slug out of https://www.udemy.com/course/<slug>/ - used as the external id. */
export function udemyCourseSlug(raw: string): string | null {
  const normalised = normaliseUdemyUrl(raw);
  if (!normalised) return null;
  const match = new URL(normalised).pathname.match(/^\/course\/([^/]+)\/?/);
  return match ? match[1] : null;
}

function withExtraParams(target: string, extraParams: string): string {
  if (!extraParams.trim()) return target;
  try {
    const url = new URL(target);
    for (const [key, value] of new URLSearchParams(extraParams.replace(/^[?&]/, ''))) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return target;
  }
}

function appendParam(base: string, key: string, value: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${key}=${encodeURIComponent(value)}`;
}

export type AffiliateLink = { url: string; network: AffiliateNetwork; tracked: boolean };

/**
 * Build the outbound link for a course.
 *
 * Falls back to the undecorated destination whenever the configuration for a
 * network is incomplete. A broken tracking link that 404s is worse than an
 * honest untracked one: the click is lost either way, but the untracked one
 * still gets the reader to the course.
 */
export function buildAffiliateUrl(rawUrl: string, cfg: AffiliateConfig): AffiliateLink | null {
  const destination = safeOutboundUrl(rawUrl);
  if (!destination) return null;

  const target = withExtraParams(destination, cfg.extraParams);
  const untracked: AffiliateLink = { url: target, network: cfg.network, tracked: false };

  switch (cfg.network) {
    case 'linksynergy': {
      if (!cfg.publisherId || !cfg.advertiserId) return untracked;
      const url =
        `https://click.linksynergy.com/deeplink?id=${encodeURIComponent(cfg.publisherId)}` +
        `&mid=${encodeURIComponent(cfg.advertiserId)}` +
        `&murl=${encodeURIComponent(target)}`;
      return { url, network: 'linksynergy', tracked: true };
    }
    case 'impact': {
      const base = safeOutboundUrl(cfg.linkBase);
      if (!base) return untracked;
      return { url: appendParam(base, 'u', target), network: 'impact', tracked: true };
    }
    case 'custom': {
      if (!cfg.template.includes('{url}') && !cfg.template.includes('{encoded_url}')) return untracked;
      const filled = cfg.template
        .replace(/\{encoded_url\}/g, encodeURIComponent(target))
        .replace(/\{url\}/g, target);
      const safe = safeOutboundUrl(filled);
      return safe ? { url: safe, network: 'custom', tracked: true } : untracked;
    }
    case 'direct':
      // Tracked only in the sense that extraParams (UTM) rides along.
      return { url: target, network: 'direct', tracked: !!cfg.extraParams.trim() };
    case 'none':
    default:
      return untracked;
  }
}

// ------------------------------------------------------------ the API -------

export type UdemyCredentials = { clientId: string; clientSecret: string };

export type CourseRecord = {
  external_id: string;
  title: string;
  url: string;
  instructor: string;
  headline: string;
  image_url: string;
  price_cents: number;
  currency: string;
  rating: number;
  reviews: number;
  students: number;
  duration_minutes: number;
  level: string;
};

/** "12.5 total hours" / "43 mins" / "2 total hours" -> minutes. */
export function parseContentDuration(info: unknown): number {
  if (typeof info !== 'string') return 0;
  let minutes = 0;
  const pattern = /([\d.]+)\s*(?:total\s+)?(hours?|hrs?|minutes?|mins?)/gi;
  for (const match of info.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    minutes += /^h/i.test(match[2]) ? value * 60 : value;
  }
  return Math.round(minutes);
}

function toCents(amount: unknown): number {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/**
 * Map one course object from the Affiliate API onto a catalogue row.
 *
 * Written defensively on purpose: this is the one place where an outside
 * schema meets Helm's, the API's field set has changed before, and an absent
 * field should cost you a rating badge, not the whole import.
 */
export function parseUdemyCourse(raw: any): CourseRecord | null {
  if (!raw || (raw.id === undefined && !raw.url)) return null;
  const relative = typeof raw.url === 'string' ? raw.url : '';
  const absolute = relative.startsWith('http')
    ? relative
    : `https://www.udemy.com${relative.startsWith('/') ? '' : '/'}${relative}`;
  const url = normaliseUdemyUrl(absolute);
  if (!url) return null;

  const instructors = Array.isArray(raw.visible_instructors) ? raw.visible_instructors : [];
  const priceDetail = raw.price_detail ?? null;

  return {
    external_id: String(raw.id ?? udemyCourseSlug(url) ?? url),
    title: String(raw.title ?? 'Untitled course'),
    url,
    instructor: instructors.map((i: any) => i?.title).filter(Boolean).join(', '),
    headline: String(raw.headline ?? ''),
    image_url: String(raw.image_240x135 ?? raw.image_125_H ?? raw.image_480x270 ?? ''),
    price_cents: toCents(priceDetail?.amount ?? raw.price),
    currency: String(priceDetail?.currency ?? 'USD').toUpperCase(),
    rating: Number(raw.avg_rating ?? raw.rating ?? 0) || 0,
    reviews: Number(raw.num_reviews ?? 0) || 0,
    students: Number(raw.num_subscribers ?? 0) || 0,
    duration_minutes: parseContentDuration(raw.content_info ?? raw.content_info_short),
    level: String(raw.instructional_level ?? raw.instructional_level_simple ?? ''),
  };
}

const API_BASE = 'https://www.udemy.com/api-2.0/courses/';

/** The field set the catalogue actually stores - asking for less keeps responses small. */
const FIELDS = [
  'id', 'title', 'url', 'headline', 'price_detail', 'avg_rating', 'num_reviews',
  'num_subscribers', 'content_info', 'instructional_level', 'image_240x135',
  'visible_instructors',
].join(',');

export function buildSearchUrl(term: string, opts: { pageSize?: number; ordering?: string } = {}): string {
  const url = new URL(API_BASE);
  url.searchParams.set('search', term);
  url.searchParams.set('page_size', String(Math.min(Math.max(opts.pageSize ?? 10, 1), 50)));
  // Relevance alone surfaces a lot of thin courses; highest-rated is the more
  // defensible default when you are about to recommend one to someone.
  url.searchParams.set('ordering', opts.ordering ?? 'highest-rated');
  url.searchParams.set('fields[course]', FIELDS);
  return url.toString();
}

export type SearchOutcome = { courses: CourseRecord[]; error?: string };

/**
 * Search the Udemy catalogue.
 *
 * Returns an outcome object rather than throwing: a missing API key is an
 * ordinary state of this module, not an exception, and the UI needs to say so
 * plainly instead of showing a stack trace.
 */
export async function searchUdemy(
  term: string,
  credentials: UdemyCredentials | null,
  opts: { pageSize?: number; ordering?: string } = {}
): Promise<SearchOutcome> {
  if (!credentials?.clientId || !credentials?.clientSecret) {
    return { courses: [], error: 'No Udemy API credentials configured' };
  }
  if (!term.trim()) return { courses: [], error: 'Empty search term' };

  const auth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  try {
    const res = await fetch(buildSearchUrl(term, opts), {
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json, text/plain, */*',
        'user-agent': config.userAgent,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        courses: [],
        error:
          'Udemy rejected the credentials (HTTP ' +
          res.status +
          '). The Affiliate API is only open to approved affiliates.',
      };
    }
    if (!res.ok) return { courses: [], error: `Udemy API returned HTTP ${res.status}` };
    const body: any = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    return { courses: results.map(parseUdemyCourse).filter(Boolean) as CourseRecord[] };
  } catch (err: any) {
    return {
      courses: [],
      error: err?.name === 'TimeoutError' ? 'Udemy API timed out' : String(err?.message ?? err),
    };
  }
}
