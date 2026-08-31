import { all, get, run } from '../../db.js';
import { fetchPage, fetchRobots, fetchText, isAllowed, type Robots } from './fetcher.js';
import { analyze } from './analyze.js';

/** Bots whose access determines whether a site can appear in AI answers. */
const AI_AGENTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot'];

const POLITE_DELAY_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SiteChecks = {
  robots_txt: boolean;
  sitemap_xml: boolean;
  llms_txt: boolean;
  ai_bots_allowed: Record<string, boolean>;
  sitemaps: string[];
};

/** Site-wide signals that live outside any single page. */
async function siteLevelChecks(origin: string, robots: Robots): Promise<SiteChecks> {
  const [sitemap, llms] = await Promise.all([
    fetchText(`${origin}/sitemap.xml`, 8000),
    fetchText(`${origin}/llms.txt`, 8000),
  ]);
  return {
    robots_txt: robots.fetched,
    sitemap_xml: sitemap.status === 200,
    llms_txt: llms.status === 200,
    ai_bots_allowed: Object.fromEntries(AI_AGENTS.map((a) => [a, !robots.blocks(a)])),
    sitemaps: robots.sitemaps,
  };
}

/** 100 minus a severity-weighted average of the issues found per page. */
function healthScore(pages: Array<{ issues_json: string }>): number {
  if (!pages.length) return 0;
  const weights = { critical: 12, warning: 4, notice: 1 } as const;
  let penalty = 0;
  for (const page of pages) {
    try {
      for (const issue of JSON.parse(page.issues_json) as Array<{ severity: keyof typeof weights }>) {
        penalty += weights[issue.severity] ?? 1;
      }
    } catch {
      /* ignore */
    }
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty / pages.length)));
}

/**
 * Breadth-first crawl of a single site, staying on-origin and honouring
 * robots.txt. Runs in the background; progress is written to the crawl row as
 * it goes so the UI can poll.
 */
export async function runCrawl(crawlId: number): Promise<void> {
  const crawl = get<any>('SELECT * FROM seo_crawls WHERE id = ?', [crawlId]);
  if (!crawl) return;
  const site = get<any>('SELECT * FROM seo_sites WHERE id = ?', [crawl.site_id]);
  if (!site) return;

  try {
    const startUrl = new URL(site.base_url);
    const origin = startUrl.origin;
    const robots = await fetchRobots(origin);

    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl.toString(), depth: 0 }];
    const seen = new Set<string>([startUrl.toString()]);
    let crawled = 0;

    while (queue.length && crawled < crawl.max_pages) {
      const next = queue.shift()!;
      const parsed = new URL(next.url);
      if (!isAllowed(parsed.pathname, robots)) continue;

      const fetched = await fetchPage(next.url);
      crawled += 1;

      if (!fetched.html || fetched.status >= 400 || fetched.status === 0) {
        run(
          `INSERT INTO seo_pages (crawl_id, url, status_code, load_ms, depth, issues_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crawlId,
            next.url,
            fetched.status,
            fetched.ms,
            next.depth,
            JSON.stringify([
              {
                code: fetched.status === 0 ? 'unreachable' : 'http_error',
                severity: 'critical',
                message: fetched.error
                  ? `Request failed: ${fetched.error}`
                  : `Returned HTTP ${fetched.status}.`,
              },
            ]),
          ]
        );
      } else {
        const facts = analyze(fetched.html, fetched.finalUrl, origin);
        run(
          `INSERT INTO seo_pages
             (crawl_id, url, status_code, title, meta_description, h1, h2_count, word_count,
              canonical, robots_meta, internal_links, external_links, images, images_no_alt,
              schema_types, load_ms, bytes, depth, issues_json, aeo_score, aeo_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crawlId,
            fetched.finalUrl,
            fetched.status,
            facts.title,
            facts.meta_description,
            facts.h1,
            facts.h2_count,
            facts.word_count,
            facts.canonical,
            facts.robots_meta,
            facts.internal_links,
            facts.external_links,
            facts.images,
            facts.images_no_alt,
            facts.schema_types.join(', '),
            fetched.ms,
            fetched.bytes,
            next.depth,
            JSON.stringify(facts.issues),
            facts.aeo_score,
            JSON.stringify({ checks: facts.aeo_checks }),
          ]
        );

        for (const link of facts.links) {
          if (seen.size >= crawl.max_pages * 4) break;
          if (seen.has(link)) continue;
          seen.add(link);
          queue.push({ url: link, depth: next.depth + 1 });
        }
      }

      run('UPDATE seo_crawls SET pages_crawled = ? WHERE id = ?', [crawled, crawlId]);
      await sleep(POLITE_DELAY_MS);
    }

    // Duplicate titles are only visible once the whole crawl is in.
    flagDuplicateTitles(crawlId);

    const pages = all<{ issues_json: string }>(
      'SELECT issues_json FROM seo_pages WHERE crawl_id = ?',
      [crawlId]
    );
    const checks = await siteLevelChecks(origin, robots);

    run(
      `UPDATE seo_crawls
          SET status = 'done', finished_at = datetime('now'), pages_crawled = ?,
              health_score = ?, site_checks_json = ?
        WHERE id = ?`,
      [crawled, healthScore(pages), JSON.stringify(checks), crawlId]
    );
  } catch (err: any) {
    run(
      `UPDATE seo_crawls SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`,
      [String(err?.message ?? err).slice(0, 500), crawlId]
    );
  }
}

function flagDuplicateTitles(crawlId: number) {
  const dupes = all<{ title: string; n: number }>(
    `SELECT title, COUNT(*) AS n FROM seo_pages
      WHERE crawl_id = ? AND title != '' GROUP BY title HAVING n > 1`,
    [crawlId]
  );
  for (const dupe of dupes) {
    const pages = all<{ id: number; issues_json: string }>(
      'SELECT id, issues_json FROM seo_pages WHERE crawl_id = ? AND title = ?',
      [crawlId, dupe.title]
    );
    for (const page of pages) {
      let issues: any[] = [];
      try {
        issues = JSON.parse(page.issues_json);
      } catch {
        issues = [];
      }
      issues.push({
        code: 'duplicate_title',
        severity: 'warning',
        message: `Title is shared with ${dupe.n - 1} other page(s).`,
      });
      run('UPDATE seo_pages SET issues_json = ? WHERE id = ?', [JSON.stringify(issues), page.id]);
    }
  }
}
