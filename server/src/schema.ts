/**
 * Helm database schema.
 *
 * Kept as a TS string (rather than a .sql file) so the production build can be
 * bundled into a single file by esbuild without extra asset plumbing.
 *
 * Conventions:
 *   - money is stored as signed INTEGER cents, never floats
 *   - dates are 'YYYY-MM-DD' TEXT, timestamps are ISO-8601 UTC TEXT
 *   - anything free-form/structured is a JSON TEXT column suffixed `_json`
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- core ----
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Encrypted third-party credentials (API tokens for social/SERP providers).
CREATE TABLE IF NOT EXISTS credentials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service    TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  data_enc   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);

-- ------------------------------------------------------------ business ----
CREATE TABLE IF NOT EXISTS clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  company      TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  website      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',   -- active | prospect | churned
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  value_cents    INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'lead',   -- lead|qualified|proposal|won|lost
  probability    INTEGER NOT NULL DEFAULT 25,
  expected_close TEXT,
  source         TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  closed_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  number      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'draft',     -- draft|sent|paid|void
  issue_date  TEXT NOT NULL DEFAULT (date('now')),
  due_date    TEXT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  tax_rate    REAL NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  sent_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  quantity    REAL NOT NULL DEFAULT 1,
  unit_cents  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  paid_on     TEXT NOT NULL DEFAULT (date('now')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  method      TEXT NOT NULL DEFAULT '',
  reference   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- Manually tracked business KPIs (anything not derivable from other modules).
CREATE TABLE IF NOT EXISTS metrics (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL UNIQUE,
  label     TEXT NOT NULL,
  unit      TEXT NOT NULL DEFAULT '',           -- currency | percent | count
  target    REAL,
  direction TEXT NOT NULL DEFAULT 'up',         -- up | down (which way is good)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metric_values (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id INTEGER NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  period    TEXT NOT NULL,                      -- 'YYYY-MM' or 'YYYY-MM-DD'
  value     REAL NOT NULL DEFAULT 0,
  UNIQUE(metric_id, period)
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   INTEGER,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- tasks ----
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#6366f1',
  client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'active',    -- active | on_hold | done
  billable   INTEGER NOT NULL DEFAULT 0,
  rate_cents INTEGER NOT NULL DEFAULT 0,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  due_date   TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_lists_project ON task_lists(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  list_id       INTEGER REFERENCES task_lists(id) ON DELETE SET NULL,
  parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo|in_progress|blocked|done
  priority      INTEGER NOT NULL DEFAULT 2,     -- 0 urgent .. 3 low
  start_date    TEXT,
  due_date      TEXT,
  estimate_minutes INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  recurrence    TEXT NOT NULL DEFAULT '',       -- ''|daily|weekly|biweekly|monthly|yearly
  recurrence_until TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#94a3b8'
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  minutes    INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  billable   INTEGER NOT NULL DEFAULT 0,
  rate_cents INTEGER NOT NULL DEFAULT 0,
  invoiced   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project_id);

-- -------------------------------------------------------------- social ----
CREATE TABLE IF NOT EXISTS social_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,                  -- mastodon|bluesky|discord|telegram|webhook|manual
  handle        TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
  config_json   TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  body         TEXT NOT NULL DEFAULT '',
  media_json   TEXT NOT NULL DEFAULT '[]',
  link         TEXT NOT NULL DEFAULT '',
  campaign     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft|scheduled|published|partial|failed
  scheduled_at TEXT,
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_social_posts_sched ON social_posts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS social_post_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  body_override TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|published|failed
  remote_id    TEXT NOT NULL DEFAULT '',
  remote_url   TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  UNIQUE(post_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_social_targets_post ON social_post_targets(post_id);

CREATE TABLE IF NOT EXISTS social_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id   INTEGER NOT NULL REFERENCES social_post_targets(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  likes       INTEGER NOT NULL DEFAULT 0,
  shares      INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------- video ----
-- Narration audio and imagery uploaded for videos. Files live under
-- data/video/assets. The filename column is the name on disk, chosen by Helm
-- and never client-supplied, so a spec can only ever name a file Helm wrote.
CREATE TABLE IF NOT EXISTS video_assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'audio',   -- audio|image
  filename      TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL DEFAULT '',
  mime          TEXT NOT NULL DEFAULT '',
  bytes         INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL,                         -- audio only, measured on upload
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS video_projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL DEFAULT 'Untitled video',
  spec_json     TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft|queued|rendering|ready|failed
  progress      REAL NOT NULL DEFAULT 0,         -- 0..1 while rendering
  -- Filename under data/video/renders. Unguessable, because the file is served
  -- without a session so that Instagram and TikTok can fetch it.
  output_file   TEXT NOT NULL DEFAULT '',
  captions_file TEXT NOT NULL DEFAULT '',
  duration_seconds REAL,
  width         INTEGER,
  height        INTEGER,
  fps           INTEGER,
  frames        INTEGER,
  error         TEXT NOT NULL DEFAULT '',
  rendered_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status);

-- ----------------------------------------------------------- seo / aeo ----
CREATE TABLE IF NOT EXISTS seo_sites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_crawls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running', -- running|done|failed
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  max_pages    INTEGER NOT NULL DEFAULT 50,
  health_score INTEGER NOT NULL DEFAULT 0,
  site_checks_json TEXT NOT NULL DEFAULT '{}',
  error        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_seo_crawls_site ON seo_crawls(site_id, started_at DESC);

CREATE TABLE IF NOT EXISTS seo_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id      INTEGER NOT NULL REFERENCES seo_crawls(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  status_code   INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  h1            TEXT NOT NULL DEFAULT '',
  h2_count      INTEGER NOT NULL DEFAULT 0,
  word_count    INTEGER NOT NULL DEFAULT 0,
  canonical     TEXT NOT NULL DEFAULT '',
  robots_meta   TEXT NOT NULL DEFAULT '',
  internal_links INTEGER NOT NULL DEFAULT 0,
  external_links INTEGER NOT NULL DEFAULT 0,
  images        INTEGER NOT NULL DEFAULT 0,
  images_no_alt INTEGER NOT NULL DEFAULT 0,
  schema_types  TEXT NOT NULL DEFAULT '',
  load_ms       INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  depth         INTEGER NOT NULL DEFAULT 0,
  issues_json   TEXT NOT NULL DEFAULT '[]',
  aeo_score     INTEGER NOT NULL DEFAULT 0,
  aeo_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_pages_crawl ON seo_pages(crawl_id);

CREATE TABLE IF NOT EXISTS seo_keywords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL,
  country    TEXT NOT NULL DEFAULT 'us',
  device     TEXT NOT NULL DEFAULT 'desktop',
  intent     TEXT NOT NULL DEFAULT '',          -- informational|commercial|transactional|navigational
  volume     INTEGER NOT NULL DEFAULT 0,
  difficulty INTEGER NOT NULL DEFAULT 0,
  cpc_cents  INTEGER NOT NULL DEFAULT 0,
  target_url TEXT NOT NULL DEFAULT '',
  tracked    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, keyword, country, device)
);

CREATE TABLE IF NOT EXISTS seo_rankings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id  INTEGER NOT NULL REFERENCES seo_keywords(id) ON DELETE CASCADE,
  checked_on  TEXT NOT NULL DEFAULT (date('now')),
  engine      TEXT NOT NULL DEFAULT 'google',
  position    INTEGER,                          -- NULL = not in results
  url         TEXT NOT NULL DEFAULT '',
  serp_features TEXT NOT NULL DEFAULT '',
  ai_overview INTEGER NOT NULL DEFAULT 0,       -- cited in an AI overview / answer box
  UNIQUE(keyword_id, checked_on, engine)
);
CREATE INDEX IF NOT EXISTS idx_seo_rankings_kw ON seo_rankings(keyword_id, checked_on);

CREATE TABLE IF NOT EXISTS seo_competitors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  domain  TEXT NOT NULL,
  label   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS content_briefs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  keyword_id  INTEGER REFERENCES seo_keywords(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  target_url  TEXT NOT NULL DEFAULT '',
  outline_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  word_target INTEGER NOT NULL DEFAULT 1200,
  status      TEXT NOT NULL DEFAULT 'idea',     -- idea|drafting|review|published
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------- google search console ---
-- Ground truth for what a site actually ranks for, straight from Google.
CREATE TABLE IF NOT EXISTS gsc_syncs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'running',   -- running|done|failed
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  date_start  TEXT NOT NULL,
  date_end    TEXT NOT NULL,
  rows_fetched INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gsc_syncs_site ON gsc_syncs(site_id, started_at DESC);

CREATE TABLE IF NOT EXISTS gsc_queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id     INTEGER NOT NULL REFERENCES gsc_syncs(id) ON DELETE CASCADE,
  site_id     INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  query       TEXT NOT NULL,
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  UNIQUE(sync_id, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_queries_site ON gsc_queries(site_id, impressions DESC);

CREATE TABLE IF NOT EXISTS gsc_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id     INTEGER NOT NULL REFERENCES gsc_syncs(id) ON DELETE CASCADE,
  site_id     INTEGER NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  page        TEXT NOT NULL,
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr         REAL NOT NULL DEFAULT 0,
  position    REAL NOT NULL DEFAULT 0,
  UNIQUE(sync_id, page)
);

-- Cached keyword ideas so repeat lookups do not re-hit the source.
CREATE TABLE IF NOT EXISTS keyword_ideas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER REFERENCES seo_sites(id) ON DELETE CASCADE,
  seed       TEXT NOT NULL,
  idea       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'autocomplete',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, seed, idea)
);

-- -------------------------------------------------------------- budget ----
CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'checking', -- checking|savings|credit|cash|investment|loan
  institution     TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT 'USD',
  opening_cents   INTEGER NOT NULL DEFAULT 0,
  business        INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  kind      TEXT NOT NULL DEFAULT 'expense',    -- income|expense
  color     TEXT NOT NULL DEFAULT '#94a3b8',
  business  INTEGER NOT NULL DEFAULT 0,
  archived  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, kind)
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  txn_date     TEXT NOT NULL DEFAULT (date('now')),
  amount_cents INTEGER NOT NULL DEFAULT 0,      -- negative = outflow
  payee        TEXT NOT NULL DEFAULT '',
  memo         TEXT NOT NULL DEFAULT '',
  cleared      INTEGER NOT NULL DEFAULT 1,
  business     INTEGER NOT NULL DEFAULT 0,
  transfer_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  source       TEXT NOT NULL DEFAULT 'manual',  -- manual|import|recurring
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);

CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  month        TEXT NOT NULL,                   -- 'YYYY-MM'
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  rollover     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(month, category_id)
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  payee        TEXT NOT NULL DEFAULT '',
  memo         TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  cadence      TEXT NOT NULL DEFAULT 'monthly', -- weekly|biweekly|monthly|quarterly|yearly
  next_date    TEXT NOT NULL,
  end_date     TEXT,
  auto_post    INTEGER NOT NULL DEFAULT 1,
  business     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS savings_goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  target_cents INTEGER NOT NULL DEFAULT 0,
  saved_cents  INTEGER NOT NULL DEFAULT 0,
  target_date  TEXT,
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------- skills ----
-- A local skills taxonomy, so the gap analyser is arithmetic over rows rather
-- than a question put to a language model. Every level is normalised to 0-100
-- on the way in, whatever scale the source used (O*NET importance is 1-5, its
-- level is 0-7), so the comparisons in services/skills/gap.ts never need to
-- know where a row came from.
CREATE TABLE IF NOT EXISTS skills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,           -- 'onet:2.A.1.a', 'tech:kubernetes'
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT '',       -- Basic Skills | Knowledge | Technology | ...
  description  TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'custom', -- onet | starter | custom
  -- Extra words appended when searching a course catalogue. O*NET names are
  -- abstract ("Systems Analysis"); a course search wants "systems analysis
  -- requirements engineering".
  search_terms TEXT NOT NULL DEFAULT '',
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);

CREATE TABLE IF NOT EXISTS occupations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,            -- O*NET-SOC, e.g. '15-1252.00'
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'custom',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The required-proficiency matrix. This table *is* the skills database: one row
-- per (role, skill) saying how much the role needs it and how much it matters.
-- A gap report is a join of this against the latest self-assessment.
CREATE TABLE IF NOT EXISTS occupation_skills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occupation_id  INTEGER NOT NULL REFERENCES occupations(id) ON DELETE CASCADE,
  skill_id       INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  importance     INTEGER NOT NULL DEFAULT 50,  -- 0-100
  required_level INTEGER NOT NULL DEFAULT 50,  -- 0-100
  UNIQUE(occupation_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_occupation_skills_occ ON occupation_skills(occupation_id);

-- Self-assessment history: one row per rating rather than one column per skill,
-- so "am I actually getting better" is a query instead of a memory.
CREATE TABLE IF NOT EXISTS skill_assessments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id    INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL DEFAULT 0,      -- 0-100
  evidence    TEXT NOT NULL DEFAULT '',
  assessed_on TEXT NOT NULL DEFAULT (date('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_assessments_skill
  ON skill_assessments(skill_id, assessed_on DESC, id DESC);

-- Course catalogue. Udemy rows arrive from the affiliate API or from a pasted
-- course URL; provider 'manual' covers everything else - a book, a docs site,
-- a conference talk.
CREATE TABLE IF NOT EXISTS learning_resources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id     INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'manual', -- udemy | manual
  external_id  TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  url          TEXT NOT NULL DEFAULT '',
  instructor   TEXT NOT NULL DEFAULT '',
  headline     TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  rating       REAL NOT NULL DEFAULT 0,
  reviews      INTEGER NOT NULL DEFAULT 0,
  students     INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  level        TEXT NOT NULL DEFAULT '',       -- beginner | intermediate | expert | all
  hidden       INTEGER NOT NULL DEFAULT 0,
  -- The one course to use for this skill: what the analyser shows and what a
  -- generated plan picks up. Without it the best-rated row wins, which is the
  -- right default but not always the right answer.
  pinned       INTEGER NOT NULL DEFAULT 0,
  -- The stored URL already carries affiliate tracking, so click-time
  -- decoration is skipped. Wrapping a tracking link in another tracking link
  -- produces a URL that breaks attribution rather than doubling it.
  pre_tracked  INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT,
  -- Link health. A dead affiliate link earns nothing and costs trust, so the
  -- catalogue records when each URL was last reached and what it answered.
  checked_at   TEXT,
  check_status INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_learning_resources_skill ON learning_resources(skill_id);
-- Partial, so the many manual rows that have no external id do not collide on ''.
CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_resources_external
  ON learning_resources(provider, external_id) WHERE external_id != '';

CREATE TABLE IF NOT EXISTS learning_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occupation_id  INTEGER REFERENCES occupations(id) ON DELETE SET NULL,
  name           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active', -- active | done | archived
  weekly_minutes INTEGER NOT NULL DEFAULT 180,
  start_date     TEXT NOT NULL DEFAULT (date('now')),
  target_date    TEXT,
  -- Readiness at the moment the plan was generated, so the UI can show movement
  -- against where you started rather than only where you are.
  baseline_json  TEXT NOT NULL DEFAULT '{}',
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_plan_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id       INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  skill_id      INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  resource_id   INTEGER REFERENCES learning_resources(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo | in_progress | done | skipped
  from_level    INTEGER NOT NULL DEFAULT 0,
  target_level  INTEGER NOT NULL DEFAULT 0,
  importance    INTEGER NOT NULL DEFAULT 50,
  estimate_minutes INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  notes         TEXT NOT NULL DEFAULT '',
  completed_at  TEXT,
  UNIQUE(plan_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_plan_items_plan ON learning_plan_items(plan_id, position);

-- Affiliate click log. Helm builds the outbound link itself and records the hop,
-- so what was clicked here can be reconciled against the network's own report
-- instead of taken on faith.
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id  INTEGER REFERENCES learning_resources(id) ON DELETE CASCADE,
  plan_item_id INTEGER REFERENCES learning_plan_items(id) ON DELETE SET NULL,
  network      TEXT NOT NULL DEFAULT '',
  target_url   TEXT NOT NULL DEFAULT '',
  clicked_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_resource
  ON affiliate_clicks(resource_id, clicked_at DESC);

-- Conversions pulled back from the affiliate network. Clicks are a proxy for
-- earnings; these are the earnings. The state column is kept verbatim because a PENDING
-- action is not money yet and a REVERSED one is money taken back - summing
-- them all as revenue would overstate it.
CREATE TABLE IF NOT EXISTS affiliate_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id  TEXT NOT NULL UNIQUE,           -- the network's own action id
  network      TEXT NOT NULL DEFAULT 'impact',
  resource_id  INTEGER REFERENCES learning_resources(id) ON DELETE SET NULL,
  skill_id     INTEGER REFERENCES skills(id) ON DELETE SET NULL,
  campaign     TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT '',       -- PENDING | APPROVED | REVERSED | ...
  event_date   TEXT NOT NULL DEFAULT '',
  sale_cents   INTEGER NOT NULL DEFAULT 0,
  payout_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  sub_id       TEXT NOT NULL DEFAULT '',
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_affiliate_actions_skill ON affiliate_actions(skill_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_actions_date ON affiliate_actions(event_date DESC);

`;
