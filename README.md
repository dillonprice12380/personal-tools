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
| **Social** | Multi-account composer for X, LinkedIn, Facebook Pages, Instagram, TikTok, Mastodon, Bluesky, Discord, Telegram and webhooks; per-network character limits, scheduling queue, month calendar, background publishing with retries and token refresh | Buffer, Hootsuite |
| **SEO & AEO** | Google Search Console sync (the queries you actually rank for, with movement and ranked opportunities), site crawler, technical on-page audit, answer-engine readiness scoring, keyword ideas, rank tracking, content briefs | Semrush, Ahrefs |
| **Budget** | Accounts, transactions, envelope budgets, recurring bills, CSV import with duplicate detection, transfers, savings goals, cashflow reports | YNAB, Monarch |
| **Business** | Clients, deal pipeline, invoices with payments, bill-tracked-time-to-invoice, KPI tracking, notes | Bonsai, Harvest |
| **Dashboard** | One cross-module view: net worth, revenue, workload, queue health, search visibility, and a single "needs attention" list drawn from every module | Geckoboard |
| **Video** | Renders narrated explainer videos from a JSON spec — burnt-in captions, `.srt`/`.vtt` sidecars, frame-exact audio sync, and a verification pass over the finished file. Finished renders attach to a post from the social composer | Descript, Camtasia |
| **Skills** | A local skills database (O*NET importable), self-assessment, gap analysis ranked by importance, and a study plan that schedules itself and pushes into Tasks. Course recommendations carry your Udemy affiliate link | LinkedIn Skills, Degreed |

The modules share one SQLite database, which is the point: tracked time becomes
an invoice line, an invoice payment becomes a bank transaction, and an overdue
invoice sits in the same alert list as a failed social post.

## Getting started

Requires **Node.js 20 or newer** and git.

> **Run these in a terminal, not the Node.js REPL.** If your prompt is `>` and
> shows "Welcome to Node.js", you are in the REPL — press Ctrl+D and open
> **PowerShell** (Windows) or **Terminal** (macOS/Linux) instead.

```bash
git clone -b claude/all-in-one-business-platform-haud19 https://github.com/dillonprice12380/personal-tools.git
cd personal-tools
npm install
npm run setup
npm run build
npm start
```

Run each line on its own — they are separate commands, not one long command.

`npm run setup` writes a `.env` containing a freshly generated `HELM_SECRET`.
It never overwrites an existing one, so it is safe to re-run.

Then open <http://localhost:4000> and create your account on first run.

To browse realistic sample data first, run `npm run seed` **before** starting.
It logs in as `demo@helm.local` / `helmdemo123`.

> ⚠️ `npm run seed` clears the tasks, clients, invoices and transactions tables
> before inserting samples. Only run it on a fresh install.

Helm reads `.env` from the working directory, its parent, or the directory the
server was installed in — so a `.env` at the repo root works however you start
it. Real environment variables always take precedence over the file.

### Development

```bash
npm run dev        # API on :4000, Vite dev server on :5173 with an /api proxy
npm run typecheck  # both workspaces
npm test           # server unit tests
```

Day to day: `Ctrl+C` stops it, `npm start` starts it again (no rebuild needed).
After pulling changes, run `npm run build` first.

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

## Making videos

Helm renders narrated explainer videos from a JSON spec — the scenes, the words
on screen and your narration audio in, an MP4 with burnt-in captions out:

```bash
npm run video -- examples/video/explainer.json --check   # validate, print the timeline
npm run video -- examples/video/explainer.json           # render and verify
```

It runs offline; ffmpeg ships as a dependency. Scene lengths are taken from the
narration files, the audio track is built to the frame count sample by sample,
and the finished file is decoded and checked against the spec before the render
reports success — a mismatch is an error, not a warning. Text that will not fit
its box stops the render rather than being clipped.

**Social → Videos** does the same from the UI: upload the narration, describe the
scenes, check the timeline and preview a frame before committing to a render, then
attach the result to a post from the composer. Renders are served on an
unguessable URL without a session, because Instagram and TikTok fetch attached
media themselves — set `HELM_PUBLIC_URL` so that URL resolves from outside.

**[docs/VIDEO.md](docs/VIDEO.md)** is the spec reference.

## Skills, gaps and study plans

**Skills** keeps a local database of what roles require and what you can
actually do, and subtracts one from the other. No model call is involved: a gap
report is one SQL join and a sort, so it runs offline, costs nothing, and gives
the same answer twice.

```
gap      = max(0, required_level - current_level)
priority = gap x (importance / 100)
```

Load Helm's starter taxonomy in one click, or import the real
[O*NET database](https://www.onetcenter.org/database.html) — roughly a thousand
occupations with published importance and level ratings:

```bash
npm run skills:import -- --dir ./db_30_0_text
```

From a gap report, **Plan** lays the highest-priority gaps across a calendar
against the hours you actually have, and pushes each step into Tasks with due
dates and estimates already set — a learning plan is work, and it belongs where
the rest of the week's work is.

Each skill carries courses. Paste a Udemy URL, or connect the Udemy Affiliate
API to search the catalogue. Helm stores the plain course URL and builds your
tracked link at click time, so switching affiliate network re-points every
course at once, and every click is logged locally to reconcile against the
network's own report.

**[docs/SKILLS.md](docs/SKILLS.md)** covers the import, the scoring and the
affiliate setup.

## How this compares to Semrush and Moz

Honestly: **[docs/SEO-DATA.md](docs/SEO-DATA.md)** sets out what is achievable
and what is not. The short version — search volume, backlink indexes and
competitors' keywords need a web-scale crawl and licensed data, so they are out
of reach. But "which keywords do I rank for" is answered by Google Search
Console with your *own* data, which is better than any third-party estimate, and
it is free.

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
  src/services/video/ spec validation, frame timing, layout, encoding, verification
web/            React + Vite SPA (hand-rolled SVG charts, no chart library)
examples/video/ a complete example video spec
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

## Reaching it from your phone

Helm binds to `127.0.0.1`, so by default nothing outside the machine can reach
it. To use it from a phone, put it on a private network rather than the open
internet — **[docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)** walks through
Tailscale (a private HTTPS URL only your own devices can open), Cloudflare
Tunnel, and running Helm as a background service so it is always up.

The UI is responsive and works on a phone; add it to your home screen and it
behaves like an app.

## Backups

Everything is in one SQLite file (`data/helm.db` by default). Copy it to back
up; put it back to restore. Keep `HELM_SECRET` with it — without that key the
stored API tokens cannot be decrypted.

## Security notes

Helm has no TLS, no rate limiting and no second factor. It is built to run on
your own machine or behind something that does.

- It listens on `127.0.0.1` unless you set `HELM_HOST`, so it is not on your
  network by accident.
- Session cookies are `httpOnly`, and marked `Secure` when you set
  `HELM_SECURE_COOKIES=1` — do that whenever it is served over HTTPS.
- Only loopback is trusted as a proxy, so `X-Forwarded-*` headers cannot be
  spoofed by a remote client.

If you want it reachable beyond the machine it runs on, use a private tunnel
rather than a forwarded port: see [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md).
