# Skills: gap analysis and planning

The Skills module answers one question — *what am I missing for the work I want
to be doing, and what should I study first* — and answers it by subtraction over
a local database rather than by asking a language model.

That matters for cost and for reproducibility. A gap report is one SQL join and
a sort. It runs on every page load, offline, for free, and it gives the same
answer twice.

## How it works

Three tables carry the weight:

| Table | What it holds |
|---|---|
| `skills` | The taxonomy — one row per skill, with a stable `code` |
| `occupations` | Target roles |
| `occupation_skills` | The matrix: for each (role, skill), an **importance** and a **required level**, both 0-100 |

Your own side is `skill_assessments` — one dated row per rating, never an
overwrite, so progress is a query instead of a memory.

The analysis is then arithmetic:

```
gap      = max(0, required_level - current_level)
priority = gap × (importance / 100)
```

and the ranking is `priority` descending. Weighting by importance is the whole
point: a 40-point hole in something the role barely touches should not outrank a
20-point hole in the thing it is built on.

Overall **readiness** is importance-weighted coverage:

```
readiness = 100 × Σ(importance × min(current, required))
                / Σ(importance × required)
```

Capping the numerator at `required` is deliberate. Being an expert in something
the role wants at "competent" is not spare credit that offsets a hole elsewhere.
With no requirements loaded, readiness is `null` rather than `0` — "no profile"
and "0% ready" are different claims and the UI should not conflate them.

### Proficiency scale

Six rungs, not a free slider — a self-assessment is a judgement, and rendering it
to single percentage points would dress it up as a measurement.

| Value | Label | Meaning |
|---|---|---|
| 0 | None | Never used it |
| 20 | Novice | Followed a tutorial |
| 40 | Advanced beginner | Works with help |
| 60 | Competent | Works unsupervised |
| 80 | Proficient | Handles the awkward cases |
| 100 | Expert | Others ask you |

## Getting a skills database

### Option 1 — the starter taxonomy (instant, offline)

**Skills → Load starter taxonomy**, or `POST /api/skills-seed`.

43 skills and 6 roles aimed at someone running a small operation alone:
freelance web developer, digital marketing consultant, content creator, data
analyst, solo SaaS founder, small agency owner.

These numbers are **Helm's own curation, not survey data**. They are rows in
`occupations`/`occupation_skills` tagged `source = 'starter'`, meant as a
starting point you edit. For citable ratings, import the real thing.

### Option 2 — O*NET (authoritative, ~1,000 occupations)

[O*NET](https://www.onetcenter.org/database.html) is the US Department of
Labor's occupational database. It rates every occupation against the same skill,
knowledge and ability elements with published numeric importance and level
values — exactly the matrix this module needs.

```bash
# download and unzip the tab-delimited "text" bundle first
npm run skills:import -- --dir ./db_30_0_text
```

Options:

```bash
--only 15-1252.00,13-1161.00   # import just these occupations
--no-technology                # skip Technology Skills.txt
```

Files read (all optional — import what you have): `Occupation Data.txt`,
`Skills.txt`, `Knowledge.txt`, `Abilities.txt`, `Technology Skills.txt`.

Notes on the import:

- **Scales are normalised on the way in.** O*NET publishes importance 1-5 and
  level 0-7; both become 0-100 so nothing downstream needs to know the source.
- **Columns are matched by header name, not position.** The column set has
  shifted between releases, and a silent off-by-one would poison every number.
- **Suppressed rows are dropped.** O*NET flags `Recommend Suppress` and
  `Not Relevant` when an estimate is too thin to publish; importing them anyway
  would put invented precision into a gap report.
- **Technology Skills carries no ratings**, so those rows get flat defaults
  (hot technologies rate slightly higher) rather than fabricated numbers.
- The full bundle is around a thousand roles and 100k+ requirement rows. It
  imports fine, but `--only` keeps the role picker usable.

> **Attribution.** O*NET data is published under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Helm does not
> redistribute it — you download it yourself. If you put it in front of anyone
> else, credit O*NET. Importing upserts by code, so O*NET rows take precedence
> over starter rows describing the same element.

### Option 3 — your own

Add skills and roles by hand in the UI, or `PUT
/api/occupations/:id/requirements` with an `items` array. A hand-added row gets
`source = 'custom'` and a generated code.

## The planner

**Skills → Plan → Generate from current gaps** takes the ranked gaps and lays
them across a calendar against the hours you say you actually have.

Study time is estimated as:

```
minutes = gap × minutesPerPoint × (0.75 + importance/100 × 0.5)
```

rounded to the half hour. **This is a planning constant, not a measurement.** It
exists so a plan can schedule itself, and `minutesPerPoint` is a setting
(default 30 — one rung of the ladder ≈ 10 hours) precisely because the honest
answer is "it depends". Tune it in `PATCH /api/skills-planning-settings`.

Plans keep a snapshot of the readiness they were generated from, so later
re-assessments show movement instead of quietly rewriting history.

**Push to Tasks** creates a project and one task per step, with the due dates and
estimates already set. This is why the module lives inside Helm rather than
beside it: a learning plan is work, and it belongs where the rest of the week's
work is — with a timer on it and the same "past due" alert.

Marking a step done also records a new self-assessment at its target level, so
the next gap report reflects it rather than still showing the gap you just
closed.

## Courses and affiliate links

Each skill can carry learning resources. Two ways to fill the catalogue:

### Paste a URL (always works)

**Courses → Add by URL.** Helm validates the host, strips any tracking or coupon
params that rode along with the copied link, and stores the course. No
credentials needed. Without the API there is no metadata to fetch, so the title
stays editable rather than being invented.

### Paste a list (the fast way to fill a catalogue)

**Courses → Paste a list.** One course per line; name the skill by code or by
name, separated with a pipe or a tab. The URL can sit in any column.

```
# lines starting with a hash are ignored
https://www.udemy.com/course/slug/
starter:seo | https://www.udemy.com/course/slug/
SEO | https://www.udemy.com/course/slug/ | The SEO Bootcamp
```

Commas are deliberately *not* separators — a course title is far likelier to
contain one ("Python, Django and Flask") than a pipe is. Re-running the same
paste updates the existing rows rather than duplicating them, and lines that
name an unknown skill or a non-Udemy host are reported back rather than
silently dropped.

**Courses → Check links** then fetches each catalogued URL from *your* server
and flags the ones that no longer resolve. Course pages get retired, and a dead
affiliate link earns nothing while costing the reader's trust. The check hits
the plain course URL, never the tracked one, so it never registers a click.

### The Udemy Affiliate API (optional)

Store credentials under **Settings → Credentials** with service `udemy` and
fields `clientId` / `clientSecret`. They are encrypted at rest with the rest of
the vault.

**Courses → Search Udemy** then searches the catalogue for a skill and stores
what it finds. The search term defaults to the skill's name plus its
`search_terms`, because an O*NET element name alone ("Systems Analysis") is too
abstract to return a useful course list.

> The Affiliate API is only open to **approved** Udemy affiliates. Without
> approval it answers 401/403, which Helm surfaces as a plain message rather than
> an error — the paste-a-URL path still works, and so does every link built
> below. Nothing else in the module depends on it: plan generation never calls
> out to Udemy.

### How links are built

Helm stores the **plain course URL** and builds your tracked link at click time.
Changing network therefore re-points every catalogued course at once, with no
migration and no stale links.

| Network | What to configure |
|---|---|
| `impact` | The deep-link base from your Impact dashboard. Helm appends `?u=<course URL>`. |
| `linksynergy` | Publisher ID and merchant ID (`mid`). Udemy's is commonly `39197` — confirm it in your own dashboard. |
| `custom` | A template using `{url}` or `{encoded_url}`. |
| `direct` | The plain URL plus whatever `extraParams` you set. |
| `none` | Undecorated. |

Udemy administers its affiliate programme through a network, and the exact
deep-link shape is whatever your dashboard issues — so Helm stores that base
rather than hardcoding one vendor's format and breaking when it changes.

#### Setting up Impact: copy one link, not one per course

You do **not** need a tracking link per course. Impact deep-links with a `u`
parameter carrying the destination, so a single base covers the whole
catalogue:

```
https://imp.xxxxxxx.net/c/<account>/<ad>/<campaign>?u=https%3A%2F%2Fwww.udemy.com%2Fcourse%2Fslug%2F
```

1. In the Impact marketplace, open the Udemy program and **copy the tracking
   link once**.
2. Paste it into **Skills → Affiliate → Deep-link base**, with network set to
   `impact`.
3. The tab renders a live sample link. Click it once and confirm the click
   registers in Impact before trusting it.

Every course in the catalogue — including ones added later — is then tracked,
and switching network later re-points all of them at once.

If your program issues a format that does not take `u`, use the `custom`
network with a template containing `{encoded_url}`.

Two deliberate behaviours:

- **An incomplete configuration falls back to the plain link.** A tracking link
  that 404s loses the click *and* the reader; an untracked one only loses the
  commission. The Affiliate tab flags when a sample link comes out untracked.
- **Only absolute `http(s)` URLs are ever emitted.** The redirect endpoint sends
  a browser wherever the stored row points, so a `javascript:` URL that reached
  the database through an import must not come back out as a `Location` header.

### Clicks

Every outbound click goes through `/api/learning-resources/:id/go`, which logs
it and then redirects. **Skills → Affiliate** reports clicks by course and by
day.

This is *your* record of what was clicked here, to reconcile against the
network's own report — Helm cannot see conversions or commissions, because those
happen on the network's side. A gap between the two is normal (cookie windows,
blockers, purchases made later); a total absence of clicks in your dashboard
when Helm logged plenty means your link configuration is wrong.

> **Disclosure.** The `disclosure` setting is shown beside affiliate links in the
> UI and defaults to a usable one. The FTC requires disclosure of affiliate
> relationships, and so do Udemy's own affiliate terms. Keep it.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/skills-gap?occupation_id=` | The gap report |
| `GET /api/skills-profile?occupation_id=` | Every skill with its current level |
| `POST /api/skill-assessments` | Record one or many ratings |
| `GET /api/skills/:id/history` | Assessment history for one skill |
| `POST /api/skills-seed` | Load the starter taxonomy (idempotent) |
| `GET`/`PUT /api/occupations/:id/requirements` | Read/replace a role's matrix |
| `POST /api/learning-plans/generate` | Build a plan from current gaps |
| `PATCH /api/learning-plans/:id/items/:itemId` | Update a step |
| `POST /api/learning-plans/:id/push-tasks` | Create tasks from the plan |
| `POST /api/udemy/search` | Search the Udemy catalogue |
| `POST /api/udemy/import` | Add a course by URL |
| `POST /api/learning-resources/bulk` | Import a pasted list of courses |
| `POST /api/learning-resources/check` | Re-check catalogued URLs, flag dead ones |
| `GET /api/learning-resources/:id/go` | Logged affiliate redirect |
| `GET`/`PATCH /api/affiliate-settings` | Link configuration |
| `GET /api/affiliate-report?days=` | Clicks by course and by day |
| `GET /api/skills-summary` | Dashboard roll-up |
