# Helm

A self-hosted, single-user business operating system. Helm replaces a stack of
monthly subscriptions — a social scheduler, an SEO suite, a project manager, a
budgeting app and a BI dashboard — with one application, one database and no
recurring bill.

It is built for one person. There is no sign-up, no multi-tenancy and no
sharing: the first account you create is the only account it will ever have.

## What's in it

| Module | What it does | Replaces |
|---|---|---|
| **Tasks** | Projects, lists, subtasks, tags, comments, priorities, recurring tasks, board / list / "my day" views, time tracking with a live timer | Basecamp, ClickUp |
| **Social** | Multi-account composer, per-network character limits, scheduling queue, month calendar, background publishing with retries, failure reporting | Buffer, Hootsuite |
| **SEO & AEO** | Site crawler, technical on-page audit, answer-engine readiness scoring, rank tracking, competitor-derived content briefs | Semrush, Ahrefs |
| **Budget** | Accounts, transactions, envelope budgets, recurring bills, CSV import with duplicate detection, transfers, savings goals, cashflow reports | YNAB, Monarch |
| **Business** | Clients, deal pipeline, invoices with payments, bill-tracked-time-to-invoice, KPI tracking, notes | Bonsai, Harvest |
| **Dashboard** | One cross-module view: net worth, revenue, workload, queue health, search visibility, and a single "needs attention" list drawn from every module | Geckoboard |

The modules share one SQLite database, which is the point: tracked time becomes
an invoice line, an invoice payment becomes a bank transaction, and an overdue
invoice sits in the same alert list as a failed social post.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install

# Generate the key that encrypts stored API tokens, and keep it safe:
echo "HELM_SECRET=$(openssl rand -hex 32)" >> .env

npm run build
npm start
```

Open http://localhost:4000 and create your account on first run.

To try it with realistic demo data first:

```bash
npm run seed     # creates demo@helm.local / helmdemo123 plus sample data
```

### Development

```bash
npm run dev        # API on :4000, Vite dev server on :5173 with an /api proxy
npm run typecheck  # both workspaces
npm test           # server unit tests
```

## Connecting the outside world

Helm works fully offline. Integrations are optional, and each one degrades to a
manual workflow rather than disappearing.

### Social networks

Add accounts under **Social → Accounts**. Supported targets:

| Provider | What you need |
|---|---|
| Mastodon | `instance` URL and an `access_token` |
| Bluesky | `identifier` and an app password |
| Discord | a channel `webhook_url` |
| Telegram | `bot_token` and `chat_id` |
| Generic webhook | a `url` (Helm POSTs the post as JSON) |
| Manual | nothing — Helm schedules and reminds you, you paste it over |

X/Twitter, LinkedIn and Instagram gate their write APIs behind paid or reviewed
access. Use the **Manual** provider for those: the post is still scheduled,
planned on the calendar and tracked, and Helm prompts you to mark it posted.

### Rank tracking

Under **Settings → Rank tracking**, pick:

- **Manual** (default, free) — record positions yourself; history and trend
  charts work exactly the same.
- **SerpApi** or **Serper.dev** — Helm checks positions itself and builds
  content briefs from what actually ranks. A daily cap limits paid API calls.

The crawler, on-page audit and AEO scoring never call a third party — they fetch
your own pages and analyse them locally.

## What "AEO" means here

Answer Engine Optimisation is scored per page, out of 100, against the things
that make a page quotable by an AI answer engine:

- structured data present, and of a content type (`Article`, `FAQPage`, `HowTo`…)
- a self-contained answer in the opening paragraph
- question-shaped headings and an FAQ block
- facts in lists or tables rather than prose
- a recent visible date, and a named author or organisation
- one `H1` and a clean heading hierarchy

Site-wide, Helm also reports whether `robots.txt`, `sitemap.xml` and `llms.txt`
exist, and whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended and CCBot
are allowed to read the site at all.

## How it is put together

```
server/         Express + better-sqlite3 API
  src/schema.ts       whole database schema
  src/lib/crud.ts     route factory backing the ~30 resource endpoints
  src/routes/         one file per module, plus the cross-module dashboard
  src/services/       crawler, AEO analyser, SERP clients, publishers, scheduler
web/            React + Vite SPA (hand-rolled SVG charts, no chart library)
```

Design decisions worth knowing:

- **Money is integer cents everywhere.** No float ever holds an amount.
- **Dates** are `YYYY-MM-DD` and timestamps are ISO-8601 UTC, handled in UTC so
  a server timezone change cannot move a due date.
- **Credentials are encrypted at rest** with AES-256-GCM under `HELM_SECRET`,
  and the API returns only which fields are set, never their values.
- **The scheduler** (one interval, default 60s) publishes due posts, posts due
  recurring transactions, refreshes a capped number of rankings and clears
  expired sessions. Set `HELM_TICK_MS=0` to turn it off.
- **The crawler is polite**: same-origin only, obeys `robots.txt`, one request
  at a time with a delay, and a page cap per crawl.

## Backups

Everything is in one SQLite file (`data/helm.db` by default). Copy it to back
up; put it back to restore. Keep `HELM_SECRET` with it — without that key the
stored API tokens cannot be decrypted.

## Security notes

Helm has no TLS, no rate limiting and no second factor. It is built to run on
your own machine or behind something that does. If you expose it to a network,
put it behind a reverse proxy with HTTPS, and use a strong password — session
cookies are `httpOnly` and set `secure` when `NODE_ENV=production`.
