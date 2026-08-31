import { config } from '../../config.js';

export type Fetched = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  bytes: number;
  ms: number;
  error?: string;
};

/** GET a URL with a timeout, returning a result object rather than throwing. */
export async function fetchPage(url: string, timeoutMs = 15_000): Promise<Fetched> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': config.userAgent, accept: 'text/html,*/*' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    const html = contentType.includes('html') || contentType === '' ? await res.text() : '';
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      contentType,
      html,
      bytes: Buffer.byteLength(html),
      ms: Date.now() - started,
    };
  } catch (err: any) {
    return {
      url,
      finalUrl: url,
      status: 0,
      contentType: '',
      html: '',
      bytes: 0,
      ms: Date.now() - started,
      error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** HEAD (falling back to GET) - used for cheap broken-link checks. */
export async function checkStatus(url: string, timeoutMs = 10_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': config.userAgent },
    });
    // Some servers reject HEAD outright; retry those with a GET.
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': config.userAgent },
      });
      return getRes.status;
    }
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a plain-text resource (robots.txt, llms.txt). Kept separate from
 * fetchPage, which deliberately discards non-HTML bodies so the analyser is
 * never handed a PDF or an image.
 */
export async function fetchText(url: string, timeoutMs = 8000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': config.userAgent, accept: 'text/plain,*/*' },
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal robots.txt handling: per-user-agent Disallow prefixes. */
export type Robots = {
  fetched: boolean;
  raw: string;
  disallow: string[];
  sitemaps: string[];
  /** Whether a named bot is blocked from the whole site. */
  blocks(agent: string): boolean;
};

export async function fetchRobots(origin: string): Promise<Robots> {
  const res = await fetchText(`${origin}/robots.txt`, 8000);
  const raw = res.status === 200 ? res.text : '';
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const line of raw.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const idx = clean.indexOf(':');
    if (idx === -1) continue;
    const field = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') sitemaps.push(value);
    if (!current) continue;
    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    if (field === 'allow') current.rules.push({ allow: true, path: value });
  }

  const rulesFor = (agent: string) => {
    const lower = agent.toLowerCase();
    const exact = groups.find((g) => g.agents.some((a) => lower.includes(a) && a !== '*'));
    const wildcard = groups.find((g) => g.agents.includes('*'));
    return (exact ?? wildcard)?.rules ?? [];
  };

  for (const rule of rulesFor('helmbot')) {
    if (!rule.allow && rule.path) disallow.push(rule.path);
  }

  return {
    fetched: res.status === 200,
    raw,
    disallow,
    sitemaps,
    blocks(agent: string) {
      const rules = rulesFor(agent);
      if (!rules.length) return false;
      // Blocked site-wide when "Disallow: /" is present with no re-allow.
      const blanket = rules.some((r) => !r.allow && r.path === '/');
      const reallow = rules.some((r) => r.allow && (r.path === '/' || r.path === ''));
      return blanket && !reallow;
    },
  };
}

/** True when our crawler is allowed to request this path. */
export function isAllowed(pathname: string, robots: Robots): boolean {
  return !robots.disallow.some((prefix) => prefix && pathname.startsWith(prefix));
}
