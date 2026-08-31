import * as cheerio from 'cheerio';
import { fetchPage } from './fetcher.js';
import { fetchSerp } from './serp.js';

export type BriefSection = { heading: string; notes: string };
export type Brief = {
  title: string;
  outline: BriefSection[];
  questions: string[];
  wordTarget: number;
  schemaTypes: string[];
};

/** Question shapes that reliably surface in answer engines. */
function templateQuestions(keyword: string): string[] {
  return [
    `What is ${keyword}?`,
    `How does ${keyword} work?`,
    `How much does ${keyword} cost?`,
    `Is ${keyword} worth it?`,
    `What are the best alternatives to ${keyword}?`,
    `How do you get started with ${keyword}?`,
  ];
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Pull the H2/H3 outline and word count out of a ranking competitor page. */
async function inspectCompetitor(url: string) {
  const page = await fetchPage(url, 12_000);
  if (!page.html) return null;
  const $ = cheerio.load(page.html);
  $('script, style, nav, footer, header').remove();
  const headings = $('h2, h3')
    .toArray()
    .map((el) => $(el).text().trim().replace(/\s+/g, ' '))
    .filter((h) => h.length > 3 && h.length < 120);
  const words = $('body').text().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  return { url, headings, words };
}

/**
 * Build a content brief for a keyword.
 *
 * With a SERP provider configured, the brief is derived from what is actually
 * ranking: competitor headings, People Also Ask questions and a word target set
 * above the median of the top results. Without one, it falls back to an
 * AEO-shaped template so the feature still works on a zero-cost setup.
 */
export async function buildBrief(keyword: {
  keyword: string;
  country?: string;
  device?: string;
}): Promise<Brief> {
  const term = keyword.keyword;
  const serp = await fetchSerp(term, keyword.country ?? 'us', keyword.device ?? 'desktop');

  let questions = templateQuestions(term);
  let wordTarget = 1200;
  const competitorHeadings: string[] = [];

  if (serp) {
    if (serp.questions.length) {
      questions = [...new Set([...serp.questions, ...templateQuestions(term)])].slice(0, 10);
    }
    const inspected = (
      await Promise.all(serp.organic.slice(0, 5).map((r) => inspectCompetitor(r.link).catch(() => null)))
    ).filter(Boolean) as Array<{ headings: string[]; words: number }>;

    if (inspected.length) {
      const counts = inspected.map((i) => i.words).sort((a, b) => a - b);
      const median = counts[Math.floor(counts.length / 2)] ?? 1200;
      // Aim ~15% past the median of what already ranks.
      wordTarget = Math.max(600, Math.round((median * 1.15) / 50) * 50);
      const seen = new Set<string>();
      for (const page of inspected) {
        for (const heading of page.headings) {
          const key = heading.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          competitorHeadings.push(heading);
        }
      }
    }
  }

  const outline: BriefSection[] = [
    {
      heading: `${titleCase(term)}: direct answer`,
      notes:
        'Open with a 40-360 character answer that stands alone if quoted. State the claim before any context.',
    },
    {
      heading: `What is ${term}?`,
      notes: 'Define the term plainly, then expand. Mark up with Article or FAQPage schema.',
    },
    {
      heading: `How ${term} works`,
      notes: 'Use an ordered list of steps - lists are lifted verbatim into AI answers.',
    },
    {
      heading: `${titleCase(term)} compared`,
      notes: 'Add a comparison table with the alternatives a buyer weighs. One row per option.',
    },
    ...competitorHeadings.slice(0, 8).map((heading) => ({
      heading,
      notes: 'Covered by a page currently ranking for this term - match or beat it.',
    })),
    {
      heading: 'Frequently asked questions',
      notes: `Answer each question in 2-3 sentences. Mark up with FAQPage schema. Questions: ${questions
        .slice(0, 5)
        .join(' / ')}`,
    },
  ];

  return {
    title: `${titleCase(term)} - content brief`,
    outline,
    questions,
    wordTarget,
    schemaTypes: ['Article', 'FAQPage', 'BreadcrumbList'],
  };
}
