import * as cheerio from 'cheerio';

export type Issue = {
  code: string;
  severity: 'critical' | 'warning' | 'notice';
  message: string;
};

export type AeoCheck = { id: string; label: string; passed: boolean; weight: number; hint: string };

export type PageFacts = {
  title: string;
  meta_description: string;
  h1: string;
  h1_count: number;
  h2_count: number;
  word_count: number;
  canonical: string;
  robots_meta: string;
  internal_links: number;
  external_links: number;
  images: number;
  images_no_alt: number;
  schema_types: string[];
  links: string[];
  aeo_score: number;
  aeo_checks: AeoCheck[];
  issues: Issue[];
};

const AI_ANSWER_MIN = 40;
const AI_ANSWER_MAX = 360;

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Collect @type values from every JSON-LD block, including @graph entries. */
function schemaTypes($: cheerio.CheerioAPI): string[] {
  const types = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x));
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      /* malformed JSON-LD is reported as an issue elsewhere */
    }
  });
  return [...types];
}

function findDate($: cheerio.CheerioAPI, html: string): Date | null {
  const candidates = [
    $('meta[property="article:modified_time"]').attr('content'),
    $('meta[property="article:published_time"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
  ].filter(Boolean) as string[];
  const jsonMatch = html.match(/"date(?:Modified|Published)"\s*:\s*"([^"]+)"/);
  if (jsonMatch) candidates.push(jsonMatch[1]);
  for (const raw of candidates) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Answer Engine Optimisation scoring.
 *
 * Answer engines (AI overviews, ChatGPT, Perplexity) favour pages that state a
 * claim plainly up front, mark it up with schema, attribute it to someone, and
 * keep it fresh. Each check below maps to one of those behaviours.
 */
function scoreAeo($: cheerio.CheerioAPI, html: string, facts: Partial<PageFacts>): {
  score: number;
  checks: AeoCheck[];
} {
  const types = facts.schema_types ?? [];
  const bodyText = $('body').text();

  const firstPara = $('p')
    .toArray()
    .map((el) => $(el).text().trim().replace(/\s+/g, ' '))
    .find((t) => t.length > 20) ?? '';

  const headings = $('h2, h3')
    .toArray()
    .map((el) => $(el).text().trim());
  const questionHeadings = headings.filter((h) =>
    /^(how|what|why|when|where|who|which|can|does|do|is|are|should)\b/i.test(h) || h.endsWith('?')
  );

  const date = findDate($, html);
  const monthsOld = date ? (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.4) : Infinity;

  const hasAuthor =
    $('[rel="author"], [itemprop="author"], .author, .byline').length > 0 ||
    /"author"\s*:/.test(html) ||
    types.includes('Person');

  const contentTypes = ['Article', 'BlogPosting', 'NewsArticle', 'FAQPage', 'HowTo', 'Product', 'Recipe', 'Event'];

  const checks: AeoCheck[] = [
    {
      id: 'jsonld',
      label: 'Structured data present',
      weight: 15,
      passed: types.length > 0,
      hint: 'Add a JSON-LD block so answer engines can parse the page as an entity.',
    },
    {
      id: 'schema_type',
      label: 'Content-level schema type',
      weight: 10,
      passed: types.some((t) => contentTypes.includes(t)),
      hint: `Use a content type such as ${contentTypes.slice(0, 4).join(', ')} rather than only WebSite/Organization.`,
    },
    {
      id: 'direct_answer',
      label: 'Direct answer in the opening paragraph',
      weight: 15,
      passed: firstPara.length >= AI_ANSWER_MIN && firstPara.length <= AI_ANSWER_MAX,
      hint: `Open with a self-contained ${AI_ANSWER_MIN}-${AI_ANSWER_MAX} character answer that can be quoted on its own.`,
    },
    {
      id: 'question_headings',
      label: 'Question-shaped headings',
      weight: 10,
      passed: questionHeadings.length >= 1,
      hint: 'Phrase at least one H2/H3 as the question a searcher would actually ask.',
    },
    {
      id: 'faq',
      label: 'FAQ / Q&A block',
      weight: 10,
      passed:
        types.includes('FAQPage') ||
        types.includes('QAPage') ||
        questionHeadings.length >= 3,
      hint: 'Add an FAQ section (ideally with FAQPage schema) covering follow-up questions.',
    },
    {
      id: 'structured_content',
      label: 'Lists or tables for extractable facts',
      weight: 10,
      passed: $('ul li, ol li').length >= 3 || $('table').length > 0,
      hint: 'Put comparisons, steps and specs in lists or tables - they are lifted verbatim into answers.',
    },
    {
      id: 'freshness',
      label: 'Visible, recent date',
      weight: 10,
      passed: monthsOld <= 18,
      hint: 'Publish a dateModified within the last 18 months; stale pages are rarely cited.',
    },
    {
      id: 'attribution',
      label: 'Author or organisation attribution',
      weight: 10,
      passed: hasAuthor,
      hint: 'Name an author or organisation - answer engines weight identifiable sources.',
    },
    {
      id: 'hierarchy',
      label: 'Clean heading hierarchy',
      weight: 10,
      passed: (facts.h1_count ?? 0) === 1 && (facts.h2_count ?? 0) >= 2,
      hint: 'Use exactly one H1 and at least two H2s so sections can be extracted independently.',
    },
  ];

  void bodyText;
  const score = checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
  return { score, checks };
}

/** Parse a fetched HTML document into SEO facts, issues and an AEO score. */
export function analyze(html: string, pageUrl: string, origin: string): PageFacts {
  // $full keeps script tags (JSON-LD lives there); $ is stripped for text stats.
  const $full = cheerio.load(html);
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const title = ($('title').first().text() ?? '').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') ?? '').trim();
  const h1s = $('h1').toArray().map((el) => $(el).text().trim()).filter(Boolean);
  const h2Count = $('h2').length;
  const canonical = ($('link[rel="canonical"]').attr('href') ?? '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') ?? '').trim();

  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = text ? text.split(' ').filter(Boolean).length : 0;

  let internal = 0;
  let external = 0;
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return;
    const abs = absolute(raw, pageUrl);
    if (!abs) return;
    if (abs.startsWith(origin)) {
      internal += 1;
      links.push(abs);
    } else {
      external += 1;
    }
  });

  const images = $('img').length;
  const imagesNoAlt = $('img').filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;
  const types = schemaTypes($full);

  const partial = {
    h1_count: h1s.length,
    h2_count: h2Count,
    schema_types: types,
  };
  const aeo = scoreAeo($full, html, partial);

  const issues: Issue[] = [];
  const add = (code: string, severity: Issue['severity'], message: string) =>
    issues.push({ code, severity, message });

  if (!title) add('title_missing', 'critical', 'Page has no <title>.');
  else if (title.length > 60) add('title_long', 'warning', `Title is ${title.length} characters (aim for under 60).`);
  else if (title.length < 25) add('title_short', 'notice', `Title is only ${title.length} characters.`);

  if (!metaDescription) add('meta_description_missing', 'warning', 'No meta description.');
  else if (metaDescription.length > 160)
    add('meta_description_long', 'notice', `Meta description is ${metaDescription.length} characters (aim for under 160).`);

  if (h1s.length === 0) add('h1_missing', 'critical', 'Page has no H1.');
  else if (h1s.length > 1) add('h1_multiple', 'warning', `Page has ${h1s.length} H1 tags.`);

  if (wordCount < 300) add('thin_content', 'warning', `Only ${wordCount} words of body copy.`);
  if (!canonical) add('canonical_missing', 'notice', 'No canonical link element.');
  if (/noindex/i.test(robotsMeta)) add('noindex', 'critical', 'Page is marked noindex.');
  if (imagesNoAlt > 0)
    add('images_no_alt', 'warning', `${imagesNoAlt} of ${images} images have no alt text.`);
  if (internal === 0) add('no_internal_links', 'warning', 'Page has no internal links.');
  if (!types.length) add('no_structured_data', 'warning', 'No JSON-LD structured data found.');
  if (aeo.score < 60)
    add('low_aeo', 'warning', `AEO readiness is ${aeo.score}/100 - unlikely to be cited by answer engines.`);

  return {
    title,
    meta_description: metaDescription,
    h1: h1s[0] ?? '',
    h1_count: h1s.length,
    h2_count: h2Count,
    word_count: wordCount,
    canonical,
    robots_meta: robotsMeta,
    internal_links: internal,
    external_links: external,
    images,
    images_no_alt: imagesNoAlt,
    schema_types: types,
    links: [...new Set(links)],
    aeo_score: aeo.score,
    aeo_checks: aeo.checks,
    issues,
  };
}
