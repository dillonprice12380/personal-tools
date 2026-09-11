import { Router } from 'express';
import { all, db, get, getSetting, logActivity, run, scalar, setSetting } from '../db.js';
import { crud } from '../lib/crud.js';
import { decryptJson } from '../lib/crypto.js';
import { badRequest, notFound, parseJson, toInt, wrap } from '../lib/http.js';
import {
  PROFICIENCY,
  analyseGaps,
  clampLevel,
  proficiencyLabel,
  summarise,
  type SkillRequirement,
} from '../services/skills/gap.js';
import { buildPlan, planDuration, planProgress } from '../services/skills/plan.js';
import { STARTER_ROLES, STARTER_SKILLS } from '../services/skills/taxonomy.js';
import {
  AFFILIATE_DEFAULTS,
  buildAffiliateUrl,
  normaliseUdemyUrl,
  parseUdemyCourse,
  safeOutboundUrl,
  searchUdemy,
  udemyCourseSlug,
  type AffiliateConfig,
  type CourseRecord,
  type UdemyCredentials,
} from '../services/skills/udemy.js';

export const skillsRouter = Router();

/**
 * The current level for every skill: the most recent assessment wins, with the
 * row id breaking ties so two ratings entered on the same day resolve to the
 * one entered last.
 */
const LATEST_ASSESSMENT = `
  SELECT skill_id, level, assessed_on FROM (
    SELECT skill_id, level, assessed_on,
           ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY assessed_on DESC, id DESC) AS rn
      FROM skill_assessments
  ) WHERE rn = 1`;

type PlanningSettings = { minutesPerPoint: number; weeklyMinutes: number; planSize: number };

function planningSettings(): PlanningSettings {
  const stored = getSetting<Partial<PlanningSettings>>('skillsPlanning', {});
  return {
    minutesPerPoint: Number(stored.minutesPerPoint) || 30,
    weeklyMinutes: Number(stored.weeklyMinutes) || 180,
    planSize: Number(stored.planSize) || 8,
  };
}

function affiliateConfig(): AffiliateConfig {
  return { ...AFFILIATE_DEFAULTS, ...getSetting<Partial<AffiliateConfig>>('affiliate', {}) };
}

function udemyCredentials(): UdemyCredentials | null {
  const row = get<{ data_enc: string }>(
    `SELECT data_enc FROM credentials WHERE service = 'udemy' ORDER BY id DESC LIMIT 1`
  );
  if (!row) return null;
  try {
    const data = decryptJson<Record<string, string>>(row.data_enc);
    const clientId = data.clientId ?? data.client_id ?? '';
    const clientSecret = data.clientSecret ?? data.client_secret ?? '';
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch {
    // HELM_SECRET changed - surfaces in Settings as an undecryptable credential.
    return null;
  }
}

// ------------------------------------------------------------- taxonomy ----

skillsRouter.use(
  '/skills',
  crud({
    table: 'skills',
    columns: ['code', 'name', 'category', 'description', 'source', 'search_terms', 'archived'],
    required: ['name'],
    filters: ['category', 'source', 'archived'],
    search: ['name', 'description', 'search_terms'],
    orderBy: 'category ASC, name ASC',
    describe: (r) => r?.name ?? '',
    beforeWrite: (data, _req, existing) => {
      // A hand-added skill still needs a stable code, because every upsert path
      // in the module keys on it.
      if (!existing && !data.code && data.name) {
        const slug = String(data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        data.code = `custom:${slug || Date.now()}`;
        data.source = data.source ?? 'custom';
      }
    },
    hydrate: (row) => {
      const latest = get<{ level: number; assessed_on: string }>(
        `SELECT level, assessed_on FROM skill_assessments
          WHERE skill_id = ? ORDER BY assessed_on DESC, id DESC LIMIT 1`,
        [row.id]
      );
      return {
        ...row,
        current_level: latest?.level ?? null,
        assessed_on: latest?.assessed_on ?? null,
        proficiency: latest ? proficiencyLabel(latest.level) : null,
        resource_count: scalar<number>(
          'SELECT COUNT(*) FROM learning_resources WHERE skill_id = ? AND hidden = 0',
          [row.id],
          0
        ),
      };
    },
  })
);

skillsRouter.use(
  '/occupations',
  crud({
    table: 'occupations',
    columns: ['code', 'title', 'description', 'source', 'archived'],
    required: ['title'],
    filters: ['source', 'archived'],
    search: ['title', 'description', 'code'],
    orderBy: 'title ASC',
    describe: (r) => r?.title ?? '',
    beforeWrite: (data, _req, existing) => {
      if (!existing && !data.code && data.title) {
        const slug = String(data.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        data.code = `custom:${slug || Date.now()}`;
        data.source = data.source ?? 'custom';
      }
    },
    hydrate: (row) => ({
      ...row,
      skill_count: scalar<number>(
        'SELECT COUNT(*) FROM occupation_skills WHERE occupation_id = ?',
        [row.id],
        0
      ),
    }),
  })
);

/** The requirement matrix for one role. */
skillsRouter.get(
  '/occupations/:id/requirements',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM occupations WHERE id = ?', [id])) throw notFound('Occupation');
    res.json({
      items: all(
        `SELECT os.skill_id, os.importance, os.required_level,
                s.code, s.name, s.category
           FROM occupation_skills os
           JOIN skills s ON s.id = os.skill_id
          WHERE os.occupation_id = ?
          ORDER BY os.importance DESC, s.name ASC`,
        [id]
      ),
    });
  })
);

/** Replace the matrix for one role in a single transaction. */
skillsRouter.put(
  '/occupations/:id/requirements',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM occupations WHERE id = ?', [id])) throw notFound('Occupation');
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) throw badRequest('Expected an `items` array');

    db.transaction(() => {
      run('DELETE FROM occupation_skills WHERE occupation_id = ?', [id]);
      for (const item of items) {
        const skillId = toInt(item.skill_id);
        if (!skillId) continue;
        run(
          `INSERT INTO occupation_skills (occupation_id, skill_id, importance, required_level)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(occupation_id, skill_id) DO UPDATE SET
             importance = excluded.importance, required_level = excluded.required_level`,
          [id, skillId, clampLevel(item.importance), clampLevel(item.required_level)]
        );
      }
    })();

    logActivity('occupations', id, 'update', `requirements: ${items.length} skills`);
    res.json({ ok: true, count: items.length });
  })
);

/** Load the built-in starter taxonomy. Idempotent - upserts by code. */
skillsRouter.post(
  '/skills-seed',
  wrap((_req, res) => {
    let skills = 0;
    let roles = 0;
    let requirements = 0;

    db.transaction(() => {
      for (const skill of STARTER_SKILLS) {
        run(
          `INSERT INTO skills (code, name, category, description, source, search_terms)
           VALUES (?, ?, ?, ?, 'starter', ?)
           ON CONFLICT(code) DO UPDATE SET
             name = excluded.name, category = excluded.category,
             search_terms = excluded.search_terms`,
          [skill.code, skill.name, skill.category, skill.description ?? '', skill.search_terms ?? '']
        );
        skills += 1;
      }
      for (const role of STARTER_ROLES) {
        run(
          `INSERT INTO occupations (code, title, description, source)
           VALUES (?, ?, ?, 'starter')
           ON CONFLICT(code) DO UPDATE SET
             title = excluded.title, description = excluded.description`,
          [role.code, role.title, role.description]
        );
        const occupationId = scalar<number>('SELECT id FROM occupations WHERE code = ?', [role.code], 0);
        roles += 1;
        for (const [skillCode, [importance, level]] of Object.entries(role.requirements)) {
          const skillId = scalar<number>('SELECT id FROM skills WHERE code = ?', [skillCode], 0);
          if (!skillId) continue;
          run(
            `INSERT INTO occupation_skills (occupation_id, skill_id, importance, required_level)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(occupation_id, skill_id) DO UPDATE SET
               importance = excluded.importance, required_level = excluded.required_level`,
            [occupationId, skillId, clampLevel(importance), clampLevel(level)]
          );
          requirements += 1;
        }
      }
    })();

    logActivity('skills', null, 'create', `starter taxonomy: ${skills} skills, ${roles} roles`);
    res.json({ skills, roles, requirements });
  })
);

// ----------------------------------------------------------- assessment ----

skillsRouter.get('/skills-scale', (_req, res) => res.json({ items: PROFICIENCY }));

/** Every skill with its current level - the self-assessment screen. */
skillsRouter.get(
  '/skills-profile',
  wrap((req, res) => {
    const occupationId = toInt(req.query.occupation_id, 0);
    const rows = all(
      `SELECT s.id AS skill_id, s.code, s.name, s.category, s.search_terms,
              COALESCE(la.level, 0) AS current_level, la.assessed_on,
              ${occupationId ? 'os.importance, os.required_level' : 'NULL AS importance, NULL AS required_level'}
         FROM skills s
         LEFT JOIN (${LATEST_ASSESSMENT}) la ON la.skill_id = s.id
         ${occupationId ? 'LEFT JOIN occupation_skills os ON os.skill_id = s.id AND os.occupation_id = ?' : ''}
        WHERE s.archived = 0
        ORDER BY s.category ASC, s.name ASC`,
      occupationId ? [occupationId] : []
    );
    res.json({ items: rows, scale: PROFICIENCY });
  })
);

/** Record one or many self-assessments. Each is a new row, never an overwrite. */
skillsRouter.post(
  '/skill-assessments',
  wrap((req, res) => {
    const body = req.body ?? {};
    const list = Array.isArray(body.items) ? body.items : [body];
    const written: number[] = [];

    db.transaction(() => {
      for (const item of list) {
        const skillId = toInt(item.skill_id);
        if (!skillId) continue;
        if (!get('SELECT id FROM skills WHERE id = ?', [skillId])) continue;
        const info = run(
          `INSERT INTO skill_assessments (skill_id, level, evidence, assessed_on)
           VALUES (?, ?, ?, COALESCE(?, date('now')))`,
          [skillId, clampLevel(item.level), String(item.evidence ?? ''), item.assessed_on ?? null]
        );
        written.push(Number(info.lastInsertRowid));
      }
    })();

    if (!written.length) throw badRequest('No valid assessments supplied');
    logActivity('skill_assessments', written[0], 'create', `${written.length} skill rating(s)`);
    res.status(201).json({ count: written.length, ids: written });
  })
);

/** Assessment history for one skill - the progress chart. */
skillsRouter.get(
  '/skills/:id/history',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    res.json({
      items: all(
        `SELECT id, level, evidence, assessed_on, created_at FROM skill_assessments
          WHERE skill_id = ? ORDER BY assessed_on ASC, id ASC`,
        [id]
      ),
    });
  })
);

// ------------------------------------------------------------ gap report ----

function requirementRows(occupationId: number): SkillRequirement[] {
  return all<SkillRequirement>(
    `SELECT s.id AS skill_id, s.code, s.name, s.category, s.search_terms,
            os.importance, os.required_level,
            COALESCE(la.level, 0) AS current_level, la.assessed_on
       FROM occupation_skills os
       JOIN skills s ON s.id = os.skill_id
       LEFT JOIN (${LATEST_ASSESSMENT}) la ON la.skill_id = s.id
      WHERE os.occupation_id = ? AND s.archived = 0`,
    [occupationId]
  );
}

/**
 * The gap analysis. One join and a sort - no model call, which is why it is a
 * plain GET that the UI can re-run on every change without thinking about cost.
 */
skillsRouter.get(
  '/skills-gap',
  wrap((req, res) => {
    const occupationId = toInt(req.query.occupation_id);
    const occupation = get<{ id: number; title: string; code: string; source: string }>(
      'SELECT id, title, code, source FROM occupations WHERE id = ?',
      [occupationId]
    );
    if (!occupation) throw notFound('Occupation');

    const settings = planningSettings();
    const rows = analyseGaps(requirementRows(occupationId));

    res.json({
      occupation,
      summary: summarise(rows, settings.minutesPerPoint),
      items: rows.map((row) => ({
        ...row,
        required_label: proficiencyLabel(row.required_level),
        current_label: proficiencyLabel(row.current_level),
      })),
      settings,
    });
  })
);

// ------------------------------------------------------------- resources ----

const RESOURCE_COLUMNS = [
  'skill_id', 'provider', 'external_id', 'title', 'url', 'instructor', 'headline',
  'image_url', 'price_cents', 'currency', 'rating', 'reviews', 'students',
  'duration_minutes', 'level', 'hidden',
];

/**
 * Outbound click. Helm builds the tracked link here rather than storing it on
 * the row, so changing affiliate network re-points every existing course at
 * once instead of needing a migration.
 */
skillsRouter.get(
  '/learning-resources/:id/go',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const resource = get<{ id: number; url: string; title: string }>(
      'SELECT id, url, title FROM learning_resources WHERE id = ?',
      [id]
    );
    if (!resource) throw notFound('Resource');

    const link = buildAffiliateUrl(resource.url, affiliateConfig());
    if (!link) throw badRequest('This resource has no usable URL');

    run(
      `INSERT INTO affiliate_clicks (resource_id, plan_item_id, network, target_url)
       VALUES (?, ?, ?, ?)`,
      [id, toInt(req.query.plan_item_id, 0) || null, link.tracked ? link.network : '', link.url]
    );
    res.redirect(302, link.url);
  })
);

skillsRouter.use(
  '/learning-resources',
  crud({
    table: 'learning_resources',
    columns: RESOURCE_COLUMNS,
    required: ['title'],
    filters: ['skill_id', 'provider', 'hidden'],
    search: ['title', 'headline', 'instructor'],
    orderBy: 'rating DESC, reviews DESC',
    describe: (r) => r?.title ?? '',
    beforeWrite: (data) => {
      if (data.url) {
        const safe = safeOutboundUrl(String(data.url));
        if (!safe) throw badRequest('URL must be an absolute http(s) address');
        data.url = safe;
      }
    },
    hydrate: (row) => {
      const link = buildAffiliateUrl(row.url, affiliateConfig());
      return {
        ...row,
        // The tracked URL is never handed to the browser directly: the click
        // goes through /go so it lands in the click log.
        go_url: `/api/learning-resources/${row.id}/go`,
        affiliate_network: link?.tracked ? link.network : '',
        clicks: scalar<number>(
          'SELECT COUNT(*) FROM affiliate_clicks WHERE resource_id = ?',
          [row.id],
          0
        ),
      };
    },
  })
);

function saveCourse(skillId: number | null, course: CourseRecord): number {
  run(
    `INSERT INTO learning_resources
       (skill_id, provider, external_id, title, url, instructor, headline, image_url,
        price_cents, currency, rating, reviews, students, duration_minutes, level, synced_at)
     VALUES (?, 'udemy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     -- The unique index on (provider, external_id) is partial, so the upsert
     -- target has to repeat its predicate or SQLite will not match it.
     ON CONFLICT(provider, external_id) WHERE external_id != '' DO UPDATE SET
       skill_id = COALESCE(excluded.skill_id, learning_resources.skill_id),
       title = excluded.title, url = excluded.url, instructor = excluded.instructor,
       headline = excluded.headline, image_url = excluded.image_url,
       price_cents = excluded.price_cents, currency = excluded.currency,
       rating = excluded.rating, reviews = excluded.reviews, students = excluded.students,
       duration_minutes = excluded.duration_minutes, level = excluded.level,
       synced_at = excluded.synced_at`,
    [
      skillId, course.external_id, course.title, course.url, course.instructor, course.headline,
      course.image_url, course.price_cents, course.currency, course.rating, course.reviews,
      course.students, course.duration_minutes, course.level,
    ]
  );
  return scalar<number>(
    `SELECT id FROM learning_resources WHERE provider = 'udemy' AND external_id = ?`,
    [course.external_id],
    0
  );
}

/**
 * Search Udemy for courses covering a skill.
 *
 * The search term defaults to the skill's name plus its `search_terms`, because
 * an O*NET element name on its own ("Systems Analysis") is too abstract to
 * return a useful course list.
 */
skillsRouter.post(
  '/udemy/search',
  wrap(async (req, res) => {
    const skillId = toInt(req.body?.skill_id, 0);
    const skill = skillId
      ? get<{ name: string; search_terms: string }>(
          'SELECT name, search_terms FROM skills WHERE id = ?',
          [skillId]
        )
      : null;
    const term = String(
      req.body?.q ?? [skill?.name, skill?.search_terms].filter(Boolean).join(' ')
    ).trim();
    if (!term) throw badRequest('Nothing to search for');

    const outcome = await searchUdemy(term, udemyCredentials(), {
      pageSize: toInt(req.body?.page_size, 10),
      ordering: req.body?.ordering,
    });

    const save = req.body?.save !== false && skillId > 0;
    const items = outcome.courses.map((course) => ({
      ...course,
      id: save ? saveCourse(skillId, course) : null,
    }));
    res.json({ term, items, error: outcome.error ?? null, saved: save });
  })
);

/** Add a course by pasting its Udemy URL - the path that needs no API access. */
skillsRouter.post(
  '/udemy/import',
  wrap((req, res) => {
    const url = normaliseUdemyUrl(String(req.body?.url ?? ''));
    if (!url) throw badRequest('Not a Udemy course URL');
    const slug = udemyCourseSlug(url);
    if (!slug) throw badRequest('Could not read a course slug out of that URL');

    const skillId = toInt(req.body?.skill_id, 0) || null;
    const id = saveCourse(skillId, {
      external_id: slug,
      // Without the API there is no metadata to fetch, so the title falls back
      // to the slug and stays editable rather than being invented.
      title: String(req.body?.title ?? slug.replace(/-/g, ' ')),
      url,
      instructor: String(req.body?.instructor ?? ''),
      headline: '',
      image_url: '',
      price_cents: toInt(req.body?.price_cents, 0),
      currency: String(req.body?.currency ?? 'USD'),
      rating: 0,
      reviews: 0,
      students: 0,
      duration_minutes: toInt(req.body?.duration_minutes, 0),
      level: String(req.body?.level ?? ''),
    });
    res.status(201).json(get('SELECT * FROM learning_resources WHERE id = ?', [id]));
  })
);

// ------------------------------------------------------------- affiliate ----

skillsRouter.get(
  '/affiliate-settings',
  wrap((_req, res) => {
    const cfg = affiliateConfig();
    const credentials = udemyCredentials();
    const sample = buildAffiliateUrl('https://www.udemy.com/course/example-course/', cfg);
    res.json({
      ...cfg,
      udemy_api_configured: !!credentials,
      // So the Settings screen can show what a link will actually look like
      // before anyone clicks one in anger.
      sample_url: sample?.url ?? '',
      sample_tracked: sample?.tracked ?? false,
    });
  })
);

skillsRouter.patch(
  '/affiliate-settings',
  wrap((req, res) => {
    const next = { ...affiliateConfig() };
    for (const key of Object.keys(AFFILIATE_DEFAULTS) as Array<keyof AffiliateConfig>) {
      if (req.body?.[key] !== undefined) (next as any)[key] = String(req.body[key]);
    }
    setSetting('affiliate', next);
    const sample = buildAffiliateUrl('https://www.udemy.com/course/example-course/', next);
    res.json({ ...next, sample_url: sample?.url ?? '', sample_tracked: sample?.tracked ?? false });
  })
);

/** What has actually been clicked, so earnings can be reconciled against it. */
skillsRouter.get(
  '/affiliate-report',
  wrap((req, res) => {
    const days = Math.min(Math.max(toInt(req.query.days, 90), 1), 365);
    const since = `-${days} days`;
    res.json({
      days,
      total_clicks: scalar<number>(
        `SELECT COUNT(*) FROM affiliate_clicks WHERE clicked_at >= datetime('now', ?)`,
        [since],
        0
      ),
      tracked_clicks: scalar<number>(
        `SELECT COUNT(*) FROM affiliate_clicks WHERE network != '' AND clicked_at >= datetime('now', ?)`,
        [since],
        0
      ),
      by_resource: all(
        `SELECT r.id, r.title, r.provider, r.url, s.name AS skill_name,
                COUNT(c.id) AS clicks, MAX(c.clicked_at) AS last_click
           FROM affiliate_clicks c
           JOIN learning_resources r ON r.id = c.resource_id
           LEFT JOIN skills s ON s.id = r.skill_id
          WHERE c.clicked_at >= datetime('now', ?)
          GROUP BY r.id ORDER BY clicks DESC LIMIT 50`,
        [since]
      ),
      by_day: all(
        `SELECT date(clicked_at) AS day, COUNT(*) AS clicks
           FROM affiliate_clicks WHERE clicked_at >= datetime('now', ?)
          GROUP BY day ORDER BY day ASC`,
        [since]
      ),
    });
  })
);

// ------------------------------------------------------------------ plans ---

function hydratePlan(row: any) {
  const items = all(
    `SELECT i.*, s.name AS skill_name, s.category AS skill_category,
            r.title AS resource_title, r.provider AS resource_provider,
            r.duration_minutes AS resource_minutes, r.rating AS resource_rating,
            t.status AS task_status
       FROM learning_plan_items i
       JOIN skills s ON s.id = i.skill_id
       LEFT JOIN learning_resources r ON r.id = i.resource_id
       LEFT JOIN tasks t ON t.id = i.task_id
      WHERE i.plan_id = ?
      ORDER BY i.position ASC, i.id ASC`,
    [row.id]
  );
  return {
    ...row,
    baseline: parseJson(row.baseline_json, {} as Record<string, unknown>),
    occupation_title: row.occupation_id
      ? scalar<string>('SELECT title FROM occupations WHERE id = ?', [row.occupation_id], '')
      : '',
    items: items.map((item: any) => ({
      ...item,
      go_url: item.resource_id
        ? `/api/learning-resources/${item.resource_id}/go?plan_item_id=${item.id}`
        : null,
    })),
    progress: planProgress(items as any),
  };
}

skillsRouter.use(
  '/learning-plans',
  crud({
    table: 'learning_plans',
    columns: ['occupation_id', 'name', 'status', 'weekly_minutes', 'start_date', 'target_date', 'project_id'],
    filters: ['status', 'occupation_id'],
    search: ['name'],
    orderBy: "CASE status WHEN 'active' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, created_at DESC",
    describe: (r) => r?.name ?? '',
    hydrate: hydratePlan,
    beforeWrite: (data, _req, existing) => {
      if (existing) data.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    },
    disable: ['create'],
  })
);

/**
 * Generate a plan from the current gap report.
 *
 * Deliberately a snapshot: the plan keeps the levels it was built from, so
 * later re-assessments show movement instead of quietly rewriting history.
 */
skillsRouter.post(
  '/learning-plans/generate',
  wrap((req, res) => {
    const occupationId = toInt(req.body?.occupation_id);
    const occupation = get<{ id: number; title: string }>(
      'SELECT id, title FROM occupations WHERE id = ?',
      [occupationId]
    );
    if (!occupation) throw notFound('Occupation');

    const settings = planningSettings();
    const weeklyMinutes = toInt(req.body?.weekly_minutes, settings.weeklyMinutes) || settings.weeklyMinutes;
    const gaps = analyseGaps(requirementRows(occupationId));
    const summary = summarise(gaps, settings.minutesPerPoint);

    const drafts = buildPlan(gaps, {
      limit: toInt(req.body?.limit, settings.planSize) || settings.planSize,
      weeklyMinutes,
      minutesPerPoint: settings.minutesPerPoint,
      minGap: toInt(req.body?.min_gap, 5),
    });
    if (!drafts.length) {
      throw badRequest(
        'No gaps big enough to plan for. Assess more skills, or lower the minimum gap.'
      );
    }

    const startDate = new Date().toISOString().slice(0, 10);
    let planId = 0;

    db.transaction(() => {
      const info = run(
        `INSERT INTO learning_plans
           (occupation_id, name, weekly_minutes, start_date, target_date, baseline_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          occupationId,
          String(req.body?.name ?? `${occupation.title} — development plan`),
          weeklyMinutes,
          startDate,
          drafts[drafts.length - 1].due_date,
          JSON.stringify(summary),
        ]
      );
      planId = Number(info.lastInsertRowid);

      for (const draft of drafts) {
        // Pick the best already-catalogued course for the skill. Nothing is
        // fetched here: generating a plan must not depend on Udemy answering.
        const resourceId = scalar<number>(
          `SELECT id FROM learning_resources
            WHERE skill_id = ? AND hidden = 0
            ORDER BY rating DESC, reviews DESC, id ASC LIMIT 1`,
          [draft.skill_id],
          0
        );
        run(
          `INSERT INTO learning_plan_items
             (plan_id, skill_id, resource_id, position, from_level, target_level,
              importance, estimate_minutes, due_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            planId, draft.skill_id, resourceId || null, draft.position, draft.from_level,
            draft.target_level, draft.importance, draft.estimate_minutes, draft.due_date,
          ]
        );
      }
    })();

    logActivity('learning_plans', planId, 'create', `${drafts.length} step plan for ${occupation.title}`);
    res.status(201).json(hydratePlan(get('SELECT * FROM learning_plans WHERE id = ?', [planId])));
  })
);

skillsRouter.patch(
  '/learning-plans/:planId/items/:itemId',
  wrap((req, res) => {
    const planId = toInt(req.params.planId);
    const itemId = toInt(req.params.itemId);
    const item = get<any>('SELECT * FROM learning_plan_items WHERE id = ? AND plan_id = ?', [
      itemId,
      planId,
    ]);
    if (!item) throw notFound('Plan item');

    const body = req.body ?? {};
    const updates: Array<[string, any]> = [];
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!['todo', 'in_progress', 'done', 'skipped'].includes(status)) {
        throw badRequest('Unknown status');
      }
      updates.push(['status', status]);
      updates.push(['completed_at', status === 'done' ? new Date().toISOString() : null]);
    }
    if (body.resource_id !== undefined) updates.push(['resource_id', toInt(body.resource_id) || null]);
    if (body.notes !== undefined) updates.push(['notes', String(body.notes)]);
    if (body.position !== undefined) updates.push(['position', toInt(body.position)]);
    if (body.due_date !== undefined) updates.push(['due_date', body.due_date || null]);
    if (body.estimate_minutes !== undefined) {
      updates.push(['estimate_minutes', Math.max(0, toInt(body.estimate_minutes))]);
    }
    if (updates.length) {
      run(
        `UPDATE learning_plan_items SET ${updates.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...updates.map(([, v]) => v), itemId]
      );
    }

    // Completing a step is a claim about proficiency, so record it as one -
    // otherwise the next gap report still shows the gap you just closed.
    if (body.status === 'done' && body.record_assessment !== false) {
      run(
        `INSERT INTO skill_assessments (skill_id, level, evidence)
         VALUES (?, ?, ?)`,
        [item.skill_id, clampLevel(body.new_level ?? item.target_level), 'Learning plan step completed']
      );
    }

    // Keep the linked task in step, so the plan and Tasks never disagree.
    if (item.task_id && body.status !== undefined) {
      const taskStatus = body.status === 'done' ? 'done' : body.status === 'in_progress' ? 'in_progress' : 'todo';
      run(
        `UPDATE tasks SET status = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
        [taskStatus, taskStatus === 'done' ? new Date().toISOString() : null, item.task_id]
      );
    }

    res.json(hydratePlan(get('SELECT * FROM learning_plans WHERE id = ?', [planId])));
  })
);

/**
 * Push the plan into Tasks.
 *
 * This is the reason the module sits inside Helm rather than beside it: a
 * learning plan is work, and work belongs where the rest of the week's work
 * already is - with due dates, a timer, and the same "past due" alert.
 */
skillsRouter.post(
  '/learning-plans/:id/push-tasks',
  wrap((req, res) => {
    const planId = toInt(req.params.id);
    const plan = get<any>('SELECT * FROM learning_plans WHERE id = ?', [planId]);
    if (!plan) throw notFound('Plan');

    let projectId = plan.project_id as number | null;
    let created = 0;
    let linked = 0;

    db.transaction(() => {
      if (!projectId || !get('SELECT id FROM projects WHERE id = ?', [projectId])) {
        const info = run(
          `INSERT INTO projects (name, description, color, status)
           VALUES (?, ?, '#0ea5e9', 'active')`,
          [plan.name || 'Development plan', 'Generated by the Helm skills planner.']
        );
        projectId = Number(info.lastInsertRowid);
        run('UPDATE learning_plans SET project_id = ? WHERE id = ?', [projectId, planId]);
      }

      const items = all<any>(
        `SELECT i.*, s.name AS skill_name, r.title AS resource_title, r.url AS resource_url
           FROM learning_plan_items i
           JOIN skills s ON s.id = i.skill_id
           LEFT JOIN learning_resources r ON r.id = i.resource_id
          WHERE i.plan_id = ? ORDER BY i.position ASC`,
        [planId]
      );

      for (const item of items) {
        if (item.task_id && get('SELECT id FROM tasks WHERE id = ?', [item.task_id])) {
          linked += 1;
          continue;
        }
        const description = [
          `Take ${item.skill_name} from ${proficiencyLabel(item.from_level)} to ${proficiencyLabel(item.target_level)}.`,
          item.resource_title ? `Course: ${item.resource_title}` : '',
          item.resource_id ? `Open via Helm: /api/learning-resources/${item.resource_id}/go?plan_item_id=${item.id}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const info = run(
          `INSERT INTO tasks (project_id, title, description, status, priority, due_date, estimate_minutes, position)
           VALUES (?, ?, ?, 'todo', ?, ?, ?, ?)`,
          [
            projectId,
            `Learn: ${item.skill_name}`,
            description,
            // Importance maps onto Helm's 0-urgent..3-low task priority.
            item.importance >= 80 ? 1 : item.importance >= 55 ? 2 : 3,
            item.due_date,
            item.estimate_minutes,
            item.position,
          ]
        );
        run('UPDATE learning_plan_items SET task_id = ? WHERE id = ?', [
          Number(info.lastInsertRowid),
          item.id,
        ]);
        created += 1;
      }
    })();

    logActivity('learning_plans', planId, 'update', `pushed ${created} step(s) to tasks`);
    res.json({ project_id: projectId, created, already_linked: linked });
  })
);

// ---------------------------------------------------------------- summary ---

/** Compact roll-up for the dashboard. */
skillsRouter.get(
  '/skills-summary',
  wrap((_req, res) => {
    const settings = planningSettings();
    const plan = get<any>(
      `SELECT * FROM learning_plans WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );

    let active: Record<string, unknown> | null = null;
    if (plan) {
      const hydrated = hydratePlan(plan);
      const next = hydrated.items.find((i: any) => i.status !== 'done' && i.status !== 'skipped');
      active = {
        id: plan.id,
        name: plan.name,
        progress: hydrated.progress,
        next_skill: next?.skill_name ?? null,
        next_due: next?.due_date ?? null,
        overdue: hydrated.items.filter(
          (i: any) => i.status !== 'done' && i.status !== 'skipped' && i.due_date && i.due_date < new Date().toISOString().slice(0, 10)
        ).length,
      };
    }

    const targetId = plan?.occupation_id ?? scalar<number>('SELECT id FROM occupations ORDER BY id LIMIT 1', [], 0);
    const gaps = targetId ? analyseGaps(requirementRows(targetId)) : [];

    res.json({
      skills: scalar<number>('SELECT COUNT(*) FROM skills WHERE archived = 0', [], 0),
      occupations: scalar<number>('SELECT COUNT(*) FROM occupations WHERE archived = 0', [], 0),
      assessed: scalar<number>('SELECT COUNT(DISTINCT skill_id) FROM skill_assessments', [], 0),
      target: targetId
        ? { id: targetId, title: scalar<string>('SELECT title FROM occupations WHERE id = ?', [targetId], '') }
        : null,
      summary: gaps.length ? summarise(gaps, settings.minutesPerPoint) : null,
      top_gaps: gaps.filter((g) => g.gap > 0).slice(0, 5),
      active_plan: active,
      clicks_30d: scalar<number>(
        `SELECT COUNT(*) FROM affiliate_clicks WHERE clicked_at >= datetime('now', '-30 days')`,
        [],
        0
      ),
    });
  })
);

skillsRouter.get(
  '/skills-planning-settings',
  wrap((_req, res) => res.json(planningSettings()))
);

skillsRouter.patch(
  '/skills-planning-settings',
  wrap((req, res) => {
    const next = { ...planningSettings() };
    if (req.body?.minutesPerPoint !== undefined) {
      next.minutesPerPoint = Math.min(Math.max(toInt(req.body.minutesPerPoint, 30), 1), 240);
    }
    if (req.body?.weeklyMinutes !== undefined) {
      next.weeklyMinutes = Math.min(Math.max(toInt(req.body.weeklyMinutes, 180), 30), 3000);
    }
    if (req.body?.planSize !== undefined) {
      next.planSize = Math.min(Math.max(toInt(req.body.planSize, 8), 1), 40);
    }
    setSetting('skillsPlanning', next);
    res.json(next);
  })
);
