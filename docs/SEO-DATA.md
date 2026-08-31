# What Helm can and cannot do versus Semrush and Moz

Semrush, Ahrefs and Moz are not really software companies — they are **data**
companies. Their products sit on two assets that cost millions a year to build
and maintain:

1. **A crawl of the web's link graph.** Billions of pages, re-crawled
   continuously. This is what Domain Authority, Domain Rating and Authority
   Score *are* — scores computed over that private graph.
2. **A SERP database.** Millions of keywords scraped daily across countries and
   devices, plus search-volume data licensed from Google Ads and clickstream
   panels.

A self-hosted tool cannot recreate either. Any tool that claims otherwise is
reselling someone else's API. So the honest question is not "how do we rebuild
Semrush" but "which of these jobs can be done another way, and how well".

---

## The scorecard

| What you want | Helm | How |
|---|---|---|
| **Which keywords do I rank for?** | ✅ **Better than Semrush** | Google Search Console — Google's own record of your impressions, clicks, CTR and position |
| Rank tracking over time | ✅ Yes | Search Console history, or a SERP API for precise daily positions |
| Technical site audit | ✅ Yes | Helm crawls your site directly |
| Answer-engine (AEO) readiness | ✅ Yes, and Semrush doesn't | Per-page scoring built in |
| Keyword ideas / phrasings | ✅ Yes | Google autocomplete, free and unmetered |
| Content briefs from what ranks | ✅ Yes | Competitor headings via a SERP API, templates without one |
| Striking-distance opportunities | ✅ Yes | Computed from your Search Console data |
| **Search volume numbers** | ❌ No | Licensed data. Needs a paid API |
| **Domain Authority / Domain Rating** | ⚠️ Proxy only | Proprietary. Helm reads Open PageRank (free) instead |
| **Backlink index** | ❌ No | Needs a web-scale crawl |
| **Competitors' keywords** | ❌ No | Needs a SERP database |

---

## The big one: Search Console beats the estimate

This is worth being clear about, because it inverts the usual assumption.

When Semrush shows "organic keywords" for your site, it is **estimating** from
its own SERP crawl. It samples a keyword universe, checks who ranks, and infers
your traffic. It never sees your actual data.

Google Search Console reports what Google *recorded*: every query that showed
your site, how many times, how many clicks it earned, and your average position.
It includes long-tail queries no keyword database has ever sampled, and it is
the only source for click-through rate.

For **your own sites**, Search Console is not a cheaper substitute for Semrush's
keyword report — it is strictly better data. Semrush's advantage is
**competitors' sites**, where you have no Search Console access.

Set it up: **Settings → Connected apps → Google Search Console → Add keys**,
then **Connect**. See [SOCIAL-SETUP.md](SOCIAL-SETUP.md) for creating the Google
Cloud app; the scope requested is read-only.

### What you get once it is synced

- **Every query you rank for**, with clicks, impressions, CTR and position
- **Movement** against your previous sync
- **Opportunities**, ranked by likely payoff:
  - *Page two, closest wins* — position 11–20 with real impressions. The
    highest-leverage work in SEO: you are one improvement from page one.
  - *Push into the top 3* — position 4–10 with heavy impressions.
  - *Rewrite title & description* — ranking well but earning about half the
    clicks that position normally does. A snippet problem, not a ranking one.
- **One-click promotion** of any query into tracked rank history

---

## Keyword ideas without a volume database

**Keyword ideas** pulls from Google's autocomplete endpoint — free, no key. It
returns the real phrasings people type, expanded across question forms
("how to…", "what is…"), commercial modifiers ("best…", "…cost", "…vs") and,
in deep mode, every letter of the alphabet appended to the seed.

What it gives you: the *language* of your market, which is the half of keyword
research that shapes what you write.

What it cannot give you: **search volume**. That number originates from Google
Ads and licensed clickstream panels. Anyone showing it is paying for it.

Two ways to fill that gap if you need it:
- **Google Keyword Planner** (free with a Google Ads account) gives volume
  ranges directly from Google.
- **A SERP API** (SerpApi, Serper) in **Settings → Rank tracking** adds precise
  position checks and competitor-derived content briefs. Costs money per query,
  so Helm rate-limits it with a daily cap.

---

## Domain authority: the honest position

**Domain Authority is a Moz metric.** Domain Rating is Ahrefs'. Authority Score
is Semrush's. Each is a proprietary score over that company's own link crawl —
they are not open formulas, and they do not agree with each other.

Helm cannot compute any of them. What it does instead: reads **Open PageRank**,
a free third-party score derived from Common Crawl link data, on a 0–10 scale.
Helm labels it as what it is rather than calling it "DA".

To enable it, get a free key at <https://www.domcop.com/openpagerank/> and add
it under Settings. Then **SEO → Overview → Domain authority → Check now**.

If you specifically need Moz's DA number, the Moz Links API has a limited free
tier — tell me and I'll wire it in alongside this.

---

## What I would actually do with this

The workflow that gets results, in order:

1. **Connect Search Console.** Everything else is guesswork until you can see
   what you already rank for.
2. **Work the opportunities list.** Page-two queries with impressions are the
   cheapest wins available to any site, and they are invisible without this data.
3. **Fix low-CTR queries.** Rewriting a title on a page already ranking at
   position 3 is an afternoon's work for an immediate gain.
4. **Run a crawl** to clear technical faults and raise the AEO scores.
5. **Only then** reach for keyword ideas and new content — expansion is worth
   less than harvesting what is already close.

Semrush is genuinely worth its price for one thing this cannot do: **researching
competitors and markets you have no access to**. If that is central to your work,
keep a subscription. If you are optimising your own sites, Search Console plus
this covers the ground.
