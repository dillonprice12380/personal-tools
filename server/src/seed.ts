/**
 * Populates a database with realistic demo data so every screen has something
 * to show. Safe to run repeatedly - it clears the demo tables first.
 *
 *   npm run seed
 */
import { db, run, get, setSetting } from './db.js';
import { createUser, userCount } from './lib/auth.js';
import { advance, today, monthKey } from './services/recurrence.js';

const DEMO_EMAIL = process.env.HELM_SEED_EMAIL || 'demo@helm.local';
const DEMO_PASSWORD = process.env.HELM_SEED_PASSWORD || 'helmdemo123';

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const stamp = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * A date `monthsAgo` months back, on `dayOfMonth`. The day is pinned to the 1st
 * before stepping the month so a 31-day current month cannot overflow into the
 * following one.
 */
const monthsBack = (monthsAgo: number, dayOfMonth = 1) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  d.setUTCDate(dayOfMonth);
  return d;
};

function reset() {
  const tables = [
    'social_metrics', 'social_post_targets', 'social_posts', 'social_accounts',
    'seo_rankings', 'seo_keywords', 'seo_pages', 'seo_crawls', 'seo_competitors',
    'content_briefs', 'seo_sites',
    'invoice_payments', 'invoice_items', 'invoices', 'deals', 'metric_values', 'metrics',
    'affiliate_clicks', 'learning_plan_items', 'learning_plans', 'learning_resources',
    'skill_assessments', 'occupation_skills', 'occupations', 'skills',
    'notes', 'time_entries', 'task_comments', 'task_tags', 'tags', 'tasks', 'task_lists',
    'projects', 'budgets', 'recurring_transactions', 'transactions', 'savings_goals',
    'categories', 'accounts', 'clients', 'activity',
  ];
  for (const table of tables) run(`DELETE FROM ${table}`);
}

const seed = db.transaction(() => {
  reset();

  // ---------------------------------------------------------- settings ----
  setSetting('businessName', 'Northlight Studio');
  setSetting('currency', 'USD');
  setSetting('invoicePrefix', 'INV-');
  setSetting('seoSerpProvider', 'manual');

  // ----------------------------------------------------------- clients ----
  const clients = [
    ['Aurora Coffee', 'Aurora Coffee Roasters', 'ops@auroracoffee.example', 'active', 12000],
    ['Bright Path Legal', 'Bright Path LLP', 'admin@brightpath.example', 'active', 18500],
    ['Ridgeline Fitness', 'Ridgeline Fitness Co', 'hello@ridgeline.example', 'prospect', 9500],
  ].map(([name, company, email, status, rate]) =>
    Number(
      run(
        `INSERT INTO clients (name, company, email, status, hourly_rate_cents, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, company, email, status, rate, 'Seeded demo client.']
      ).lastInsertRowid
    )
  );

  // ---------------------------------------------------------- projects ----
  const projects = [
    ['Aurora website rebuild', clients[0], '#f97316', 1, 12000, 850000],
    ['Bright Path content engine', clients[1], '#6366f1', 1, 18500, 1200000],
    ['Northlight internal ops', null, '#14b8a6', 0, 0, 0],
  ].map(([name, clientId, color, billable, rate, budget]) =>
    Number(
      run(
        `INSERT INTO projects (name, client_id, color, billable, rate_cents, budget_cents, status, due_date, description)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [name, clientId, color, billable, rate, budget, day(45), 'Seeded demo project.']
      ).lastInsertRowid
    )
  );

  const lists = ['Backlog', 'This week', 'In review'].flatMap((name, i) =>
    projects.map((projectId) =>
      Number(
        run('INSERT INTO task_lists (project_id, name, position) VALUES (?, ?, ?)', [
          projectId,
          name,
          i,
        ]).lastInsertRowid
      )
    )
  );

  const taskSpecs: Array<[string, number, string, number, string | null, string]> = [
    ['Migrate product pages to new template', projects[0], 'in_progress', 1, day(2), ''],
    ['Compress hero imagery (LCP > 4s)', projects[0], 'todo', 0, day(-1), ''],
    ['Write 3 FAQ blocks for espresso category', projects[0], 'todo', 2, day(5), ''],
    ['Draft Q3 legal content calendar', projects[1], 'in_progress', 1, day(1), ''],
    ['Interview partner for authority piece', projects[1], 'todo', 2, day(9), ''],
    ['Publish "family law timeline" guide', projects[1], 'todo', 1, day(14), ''],
    ['Reconcile June bank statements', projects[2], 'todo', 1, day(-3), 'monthly'],
    ['Weekly metrics review', projects[2], 'todo', 2, day(3), 'weekly'],
    ['Renew domain + SSL', projects[2], 'done', 3, day(-10), 'yearly'],
  ];
  const tasks = taskSpecs.map(([title, projectId, status, priority, due, recurrence], i) =>
    Number(
      run(
        `INSERT INTO tasks (project_id, list_id, title, status, priority, due_date, recurrence, position,
                            description, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          lists[i % lists.length],
          title,
          status,
          priority,
          due,
          recurrence,
          i,
          'Seeded demo task.',
          status === 'done' ? stamp(-240) : null,
        ]
      ).lastInsertRowid
    )
  );

  run('INSERT INTO tasks (project_id, parent_id, title, status, priority) VALUES (?, ?, ?, ?, ?)', [
    projects[0], tasks[0], 'Audit existing template overrides', 'done', 2,
  ]);
  run('INSERT INTO tasks (project_id, parent_id, title, status, priority) VALUES (?, ?, ?, ?, ?)', [
    projects[0], tasks[0], 'Port structured data blocks', 'todo', 1,
  ]);

  for (const [name, color] of [['urgent', '#ef4444'], ['content', '#8b5cf6'], ['seo', '#10b981']]) {
    const tagId = Number(run('INSERT INTO tags (name, color) VALUES (?, ?)', [name, color]).lastInsertRowid);
    run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [tasks[tagId % tasks.length], tagId]);
  }

  run('INSERT INTO task_comments (task_id, body) VALUES (?, ?)', [
    tasks[0], 'Template ported for 12 of 34 pages. Blocking issue: legacy shortcodes.',
  ]);

  for (let i = 1; i <= 8; i += 1) {
    run(
      `INSERT INTO time_entries (task_id, project_id, started_at, ended_at, minutes, note, billable, rate_cents, invoiced)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)`,
      [
        tasks[i % 6],
        projects[i % 2],
        stamp(-i * 24),
        stamp(-i * 24 + 2),
        60 + (i % 4) * 30,
        'Seeded session',
        i % 2 === 0 ? 12000 : 18500,
      ]
    );
  }

  // ------------------------------------------------------------- money ----
  const accounts = [
    ['Business checking', 'checking', 1, 1_250_00],
    ['Personal checking', 'checking', 0, 480_00],
    ['High-yield savings', 'savings', 0, 12_400_00],
    ['Business credit card', 'credit', 1, -840_00],
  ].map(([name, type, business, opening]) =>
    Number(
      run(
        'INSERT INTO accounts (name, type, business, opening_cents, institution) VALUES (?, ?, ?, ?, ?)',
        [name, type, business, opening, 'Demo Bank']
      ).lastInsertRowid
    )
  );

  const categoryDefs: Array<[string, string, string, number]> = [
    ['Client revenue', 'income', '#22c55e', 1],
    ['Software', 'expense', '#6366f1', 1],
    ['Contractors', 'expense', '#f97316', 1],
    ['Marketing', 'expense', '#ec4899', 1],
    ['Groceries', 'expense', '#14b8a6', 0],
    ['Rent', 'expense', '#64748b', 0],
    ['Dining', 'expense', '#eab308', 0],
    ['Transport', 'expense', '#0ea5e9', 0],
  ];
  const categories: Record<string, number> = {};
  for (const [name, kind, color, business] of categoryDefs) {
    categories[name] = Number(
      run('INSERT INTO categories (name, kind, color, business) VALUES (?, ?, ?, ?)', [
        name, kind, color, business,
      ]).lastInsertRowid
    );
  }

  const txnTemplates: Array<[string, number, string, number]> = [
    ['Adobe Creative Cloud', -59_99, 'Software', 3],
    ['Figma', -15_00, 'Software', 3],
    ['Whole Foods', -142_37, 'Groceries', 0],
    ['Landlord', -1_850_00, 'Rent', 0],
    ['Corner Bistro', -64_20, 'Dining', 0],
    ['Metro card', -35_00, 'Transport', 0],
    ['Meta Ads', -220_00, 'Marketing', 3],
    ['Freelance designer', -900_00, 'Contractors', 3],
  ];
  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo -= 1) {
    for (const [payee, cents, category, accountIdx] of txnTemplates) {
      const date = monthsBack(monthsAgo, 3 + (payee.length % 20)).toISOString().slice(0, 10);
      if (date > today()) continue;
      run(
        `INSERT INTO transactions (account_id, category_id, txn_date, amount_cents, payee, business, source)
         VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
        [
          accounts[accountIdx],
          categories[category],
          date,
          cents + (monthsAgo % 3) * 100,
          payee,
          accountIdx === 3 || accountIdx === 0 ? 1 : 0,
        ]
      );
    }
    run(
      `INSERT INTO transactions (account_id, category_id, txn_date, amount_cents, payee, business, source)
       VALUES (?, ?, ?, ?, ?, 1, 'manual')`,
      [
        accounts[0],
        categories['Client revenue'],
        monthsBack(monthsAgo).toISOString().slice(0, 10),
        6_400_00,
        'Client retainer',
      ]
    );
  }

  const month = monthKey(today());
  for (const [name, amount] of [
    ['Software', 150_00], ['Marketing', 400_00], ['Groceries', 600_00],
    ['Rent', 1_850_00], ['Dining', 200_00], ['Transport', 90_00], ['Contractors', 1_000_00],
  ] as Array<[string, number]>) {
    run('INSERT INTO budgets (month, category_id, amount_cents) VALUES (?, ?, ?)', [
      month, categories[name], amount,
    ]);
  }

  run(
    `INSERT INTO recurring_transactions (account_id, category_id, payee, amount_cents, cadence, next_date, business)
     VALUES (?, ?, ?, ?, 'monthly', ?, 1)`,
    [accounts[0], categories['Software'], 'Adobe Creative Cloud', -59_99, advance(today(), 'monthly')]
  );
  run(
    `INSERT INTO recurring_transactions (account_id, category_id, payee, amount_cents, cadence, next_date, business)
     VALUES (?, ?, ?, ?, 'monthly', ?, 0)`,
    [accounts[1], categories['Rent'], 'Rent', -1_850_00, day(9)]
  );

  run(
    'INSERT INTO savings_goals (name, target_cents, saved_cents, target_date, account_id) VALUES (?, ?, ?, ?, ?)',
    ['Tax reserve', 15_000_00, 8_200_00, day(120), accounts[2]]
  );
  run(
    'INSERT INTO savings_goals (name, target_cents, saved_cents, target_date, account_id) VALUES (?, ?, ?, ?, ?)',
    ['New workstation', 4_000_00, 1_150_00, day(210), accounts[2]]
  );

  // ---------------------------------------------------------- invoices ----
  const invoiceSpecs: Array<[number, string, string, string, number]> = [
    [clients[0], 'INV-0001', 'paid', day(-52), 1],
    [clients[1], 'INV-0002', 'paid', day(-24), 1],
    [clients[0], 'INV-0003', 'sent', day(-16), 0],
    [clients[1], 'INV-0004', 'draft', day(-2), 0],
  ];
  invoiceSpecs.forEach(([clientId, number, status, issue, paid]) => {
    const invoiceId = Number(
      run(
        `INSERT INTO invoices (client_id, number, status, issue_date, due_date, tax_rate, sent_at, notes)
         VALUES (?, ?, ?, ?, ?, 8.5, ?, ?)`,
        [
          clientId,
          number,
          status,
          issue,
          advance(issue, 'monthly'),
          status === 'draft' ? null : stamp(-200),
          'Thanks for your business.',
        ]
      ).lastInsertRowid
    );
    run(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_cents, position)
       VALUES (?, ?, ?, ?, 0)`,
      [invoiceId, 'Retainer - strategy and delivery', 20, 15000]
    );
    run(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_cents, position)
       VALUES (?, ?, ?, ?, 1)`,
      [invoiceId, 'Technical SEO audit', 1, 120000]
    );
    if (paid) {
      run(
        `INSERT INTO invoice_payments (invoice_id, paid_on, amount_cents, method)
         VALUES (?, ?, ?, 'bank transfer')`,
        [invoiceId, advance(issue, 'monthly'), Math.round((20 * 15000 + 120000) * 1.085)]
      );
    }
  });

  for (const [title, clientId, value, stage, probability] of [
    ['Aurora - loyalty microsite', clients[0], 1_800_000, 'proposal', 60],
    ['Ridgeline - launch retainer', clients[2], 2_400_000, 'qualified', 40],
    ['Bright Path - video series', clients[1], 900_000, 'lead', 20],
    ['Aurora - Q1 audit', clients[0], 450_000, 'won', 100],
  ] as Array<[string, number, number, string, number]>) {
    run(
      `INSERT INTO deals (client_id, title, value_cents, stage, probability, expected_close, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [clientId, title, value, stage, probability, day(30), stage === 'won' ? stamp(-500) : null]
    );
  }

  const metrics: Array<[string, string, string, number, string]> = [
    ['mrr', 'Monthly recurring revenue', 'currency', 800000, 'up'],
    ['newsletter_subs', 'Newsletter subscribers', 'count', 5000, 'up'],
    ['churn', 'Client churn', 'percent', 5, 'down'],
  ];
  for (const [key, label, unit, target, direction] of metrics) {
    const metricId = Number(
      run('INSERT INTO metrics (key, label, unit, target, direction) VALUES (?, ?, ?, ?, ?)', [
        key, label, unit, target, direction,
      ]).lastInsertRowid
    );
    for (let i = 5; i >= 0; i -= 1) {
      const base = unit === 'currency' ? 620000 + (5 - i) * 32000 : unit === 'percent' ? 8 - (5 - i) * 0.4 : 3200 + (5 - i) * 260;
      run('INSERT INTO metric_values (metric_id, period, value) VALUES (?, ?, ?)', [
        metricId, monthsBack(i).toISOString().slice(0, 7), Math.round(base * 100) / 100,
      ]);
    }
  }

  run('INSERT INTO notes (title, body, pinned) VALUES (?, ?, 1)', [
    'Positioning notes',
    'Lead with the AEO angle - it is the thing no one else in the local market is selling yet.',
  ]);

  // ------------------------------------------------------------ social ----
  const socialAccounts = [
    ['mastodon', '@northlight@mastodon.social', 'Northlight Studio'],
    ['bluesky', 'northlight.bsky.social', 'Northlight Studio'],
    ['manual', '@northlightstudio', 'Instagram (manual)'],
  ].map(([platform, handle, displayName]) =>
    Number(
      run(
        'INSERT INTO social_accounts (platform, handle, display_name, enabled) VALUES (?, ?, ?, 1)',
        [platform, handle, displayName]
      ).lastInsertRowid
    )
  );

  const posts: Array<[string, string, string, string]> = [
    ['Most "SEO audits" stop at meta tags. Here is the 12-point technical pass we run before touching a single keyword.', 'scheduled', stamp(20), 'audit-series'],
    ['Answer engines quote pages that answer in the first paragraph. Bury the lede and you will not get cited.', 'scheduled', stamp(48), 'aeo-series'],
    ['Shipped: a client site went from 41 to 88 on our page-health score in six weeks. Thread on what moved the needle.', 'published', stamp(-72), 'case-studies'],
    ['Draft: thoughts on why retainers beat project work for small studios.', 'draft', '', ''],
  ];
  posts.forEach(([body, status, scheduledAt, campaign]) => {
    const postId = Number(
      run(
        `INSERT INTO social_posts (body, status, scheduled_at, campaign, published_at)
         VALUES (?, ?, ?, ?, ?)`,
        [body, status, scheduledAt || null, campaign, status === 'published' ? scheduledAt : null]
      ).lastInsertRowid
    );
    for (const accountId of socialAccounts.slice(0, status === 'draft' ? 1 : 3)) {
      run(
        `INSERT INTO social_post_targets (post_id, account_id, status, published_at)
         VALUES (?, ?, ?, ?)`,
        [
          postId,
          accountId,
          status === 'published' ? 'published' : 'pending',
          status === 'published' ? scheduledAt : null,
        ]
      );
    }
  });

  // --------------------------------------------------------------- seo ----
  const siteId = Number(
    run('INSERT INTO seo_sites (name, base_url, client_id) VALUES (?, ?, ?)', [
      'Aurora Coffee', 'https://auroracoffee.example', clients[0],
    ]).lastInsertRowid
  );
  run('INSERT INTO seo_competitors (site_id, domain, label) VALUES (?, ?, ?)', [
    siteId, 'blueoakcoffee.example', 'Blue Oak',
  ]);

  const crawlId = Number(
    run(
      `INSERT INTO seo_crawls (site_id, status, started_at, finished_at, pages_crawled, max_pages, health_score, site_checks_json)
       VALUES (?, 'done', ?, ?, 5, 50, 74, ?)`,
      [
        siteId,
        stamp(-30),
        stamp(-29),
        JSON.stringify({
          robots_txt: true,
          sitemap_xml: true,
          llms_txt: false,
          ai_bots_allowed: { GPTBot: true, ClaudeBot: true, PerplexityBot: false, 'Google-Extended': true, CCBot: true },
          sitemaps: ['https://auroracoffee.example/sitemap.xml'],
        }),
      ]
    ).lastInsertRowid
  );

  const pages: Array<[string, string, number, number, string]> = [
    ['/', 'Aurora Coffee Roasters | Small-batch coffee', 620, 68, 'Organization, WebSite'],
    ['/shop/espresso', 'Espresso beans', 180, 42, 'Product'],
    ['/blog/brew-guide', 'How to brew espresso at home: a step-by-step guide', 1840, 91, 'Article, FAQPage'],
    ['/about', 'About us', 340, 55, ''],
    ['/wholesale', '', 260, 30, ''],
  ];
  pages.forEach(([path, title, words, aeo, schema], i) => {
    const issues: Array<{ code: string; severity: string; message: string }> = [];
    if (!title) issues.push({ code: 'title_missing', severity: 'critical', message: 'Page has no <title>.' });
    if (words < 300) issues.push({ code: 'thin_content', severity: 'warning', message: `Only ${words} words of body copy.` });
    if (!schema) issues.push({ code: 'no_structured_data', severity: 'warning', message: 'No JSON-LD structured data found.' });
    if (aeo < 60) issues.push({ code: 'low_aeo', severity: 'warning', message: `AEO readiness is ${aeo}/100.` });

    run(
      `INSERT INTO seo_pages (crawl_id, url, status_code, title, meta_description, h1, h2_count, word_count,
                              canonical, internal_links, external_links, images, images_no_alt, schema_types,
                              load_ms, bytes, depth, issues_json, aeo_score, aeo_json)
       VALUES (?, ?, 200, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crawlId, `https://auroracoffee.example${path}`, title,
        i === 4 ? '' : 'Small-batch coffee roasted weekly in Portland.',
        title.split('|')[0].trim(), Math.max(1, Math.round(words / 300)), words,
        `https://auroracoffee.example${path}`, 12 - i, 3, 6, i, schema,
        320 + i * 90, words * 12, i === 0 ? 0 : 1,
        JSON.stringify(issues), aeo,
        JSON.stringify({ checks: [] }),
      ]
    );
  });

  const keywords: Array<[string, number, number, string, number | null]> = [
    ['espresso beans portland', 1300, 42, 'commercial', 6],
    ['how to brew espresso at home', 8100, 28, 'informational', 3],
    ['wholesale coffee supplier', 2400, 61, 'transactional', 18],
    ['best coffee roasters near me', 5400, 55, 'commercial', null],
  ];
  keywords.forEach(([keyword, volume, difficulty, intent, position]) => {
    const keywordId = Number(
      run(
        `INSERT INTO seo_keywords (site_id, keyword, volume, difficulty, intent, target_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [siteId, keyword, volume, difficulty, intent, 'https://auroracoffee.example']
      ).lastInsertRowid
    );
    for (let i = 6; i >= 0; i -= 1) {
      const drift = position === null ? null : Math.max(1, position + (i % 3) - 1);
      run(
        `INSERT INTO seo_rankings (keyword_id, checked_on, position, url, ai_overview)
         VALUES (?, ?, ?, ?, ?)`,
        [
          keywordId, day(-i * 5), drift,
          drift ? 'https://auroracoffee.example' : '',
          keyword.startsWith('how to') && i < 3 ? 1 : 0,
        ]
      );
    }
  });

  run(
    `INSERT INTO content_briefs (site_id, title, outline_json, questions_json, word_target, status)
     VALUES (?, ?, ?, ?, 1600, 'drafting')`,
    [
      siteId,
      'Wholesale coffee supplier - content brief',
      JSON.stringify([
        { heading: 'Direct answer', notes: 'Lead with pricing bands and minimum order.' },
        { heading: 'How wholesale coffee pricing works', notes: 'Ordered list of the cost drivers.' },
      ]),
      JSON.stringify(['What is the minimum wholesale coffee order?', 'How much does wholesale coffee cost?']),
    ]
  );
});

seed();

if (userCount() === 0) {
  createUser(DEMO_EMAIL, DEMO_PASSWORD, 'Demo User');
  console.log(`[helm] created demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('[helm] change this password before exposing Helm to a network.');
} else {
  const existing = get<{ email: string }>('SELECT email FROM users ORDER BY id LIMIT 1');
  console.log(`[helm] kept existing account: ${existing?.email}`);
}
console.log('[helm] demo data seeded.');
