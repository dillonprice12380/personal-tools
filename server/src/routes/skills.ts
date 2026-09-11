import { Router } from 'express';
import { config } from '../config.js';
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
import { classifyReferenceUrl } from '../services/skills/links.js';
import { buildPlan, planDuration, planProgress } from '../services/skills/plan.js';
import { STARTER_ROLES, STARTER_SKILLS } from '../services/skills/taxonomy.js';
import {
  listActions,
  listCatalogItems,
  listCatalogs,
  resourceIdFromSubId,
  subIdForResource,
  type ImpactCredentials,
} from '../services/skills/impact.js';
import {
  AFFILIATE_DEFAULTS,
  buildAffiliateUrl,
  looksPreTracked,
  normaliseUdemyUrl,
  parseBulkCourseLines,
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

function impactCredentials(): ImpactCredentials | null {
  const row = get<{ data_enc: string }>(
    `SELECT data_enc FROM credentials WHERE service = 'impact' ORDER BY id DESC LIMIT 1`
  );
  if (!row) return null;
  try {
    const data = decryptJson<Record<string, string>>(row.data_enc);
    const accountSid = data.accountSid ?? data.account_sid ?? data.sid ?? '';
    const authToken = data.authToken ?? data.auth_token ?? data.token ?? '';
    return accountSid && authToken ? { accountSid, authToken } : null;
  } catch {
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
        reference: referenceFor(row.id),
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

/**
 * The reference link for a skill: paste a URL, save, done.
 *
 * The simple path, and the one that needs no API of any kind. Under it this is
 * still an ordinary catalogue row - pinned, so the analyser and the planner
 * both reach for it - which keeps one mental model ("a link per skill") over a
 * data model that can hold several.
 *
 * Any http(s) URL is accepted, not just Udemy: a book, a docs site or another
 * network's link are all legitimate references. An already-tracked link is
 * detected and passed through untouched at click time.
 */
skillsRouter.put(
  '/skills/:id/reference',
  wrap((req, res) => {
    const skillId = toInt(req.params.id);
    const skill = get<{ id: number; name: string }>('SELECT id, name FROM skills WHERE id = ?', [
      skillId,
    ]);
    if (!skill) throw notFound('Skill');

    const raw = String(req.body?.url ?? '').trim();

    // An empty URL clears the reference rather than erroring: unpinning is how
    // you undo this, and it should not require finding a different screen.
    if (!raw) {
      run('UPDATE learning_resources SET pinned = 0 WHERE skill_id = ?', [skillId]);
      logActivity('skills', skillId, 'update', `reference link cleared for ${skill.name}`);
      return res.json({ skill_id: skillId, reference: null });
    }

    const url = safeOutboundUrl(raw);
    if (!url) throw badRequest('The reference must be an absolute http(s) URL');

    const preTracked =
      req.body?.pre_tracked === undefined ? looksPreTracked(url) : !!req.body.pre_tracked;
    const title = String(req.body?.title ?? '').trim() || titleFromUrl(url) || skill.name;

    let resourceId = 0;
    db.transaction(() => {
      // Only one reference per skill; an existing row for the same URL is
      // reused so a re-save does not accumulate duplicates.
      const existing = get<{ id: number }>(
        'SELECT id FROM learning_resources WHERE skill_id = ? AND url = ?',
        [skillId, url]
      );
      if (existing) {
        run(
          `UPDATE learning_resources
              SET title = ?, pre_tracked = ?, hidden = 0 WHERE id = ?`,
          [title, preTracked ? 1 : 0, existing.id]
        );
        resourceId = existing.id;
      } else {
        const info = run(
          `INSERT INTO learning_resources
             (skill_id, provider, title, url, pre_tracked, pinned)
           VALUES (?, 'manual', ?, ?, ?, 1)`,
          [skillId, title, url, preTracked ? 1 : 0]
        );
        resourceId = Number(info.lastInsertRowid);
      }
      run('UPDATE learning_resources SET pinned = 0 WHERE skill_id = ? AND id != ?', [
        skillId,
        resourceId,
      ]);
      run('UPDATE learning_resources SET pinned = 1 WHERE id = ?', [resourceId]);
    })();

    // Warnings, not a refusal: any http(s) URL is a legitimate reference, but a
    // link that is probably a typo should say so now rather than sit in the
    // analyser earning nothing.
    const check = classifyReferenceUrl(url);
    logActivity('skills', skillId, 'update', `reference link set for ${skill.name}`);
    res.json({
      skill_id: skillId,
      reference: referenceFor(skillId),
      platform: check.platform,
      warnings: check.warnings,
    });
  })
);

/** A readable title from a URL, so a bare paste does not save as "https://…". */
function titleFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop() ?? '';
    if (!last) return new URL(url).hostname.replace(/^www\./, '');
    return last.replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  } catch {
    return '';
  }
}

/**
 * The course the analyser should show for a skill: the pinned one if there is
 * one, otherwise the best-rated row in the catalogue.
 */
function referenceFor(skillId: number) {
  const row = get<any>(
    `SELECT id, title, url, provider, pinned, pre_tracked, rating, duration_minutes, price_cents, currency
       FROM learning_resources
      WHERE skill_id = ? AND hidden = 0
      ORDER BY pinned DESC, rating DESC, reviews DESC, id ASC
      LIMIT 1`,
    [skillId]
  );
  if (!row) return null;
  return {
    ...row,
    // Always the local hop, never the destination: that is what logs the click.
    go_url: `/api/learning-resources/${row.id}/go`,
  };
}

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
        // This is the "click here to learn it" link the whole module exists to
        // put in front of someone looking at their own gap.
        reference: referenceFor(row.skill_id),
      })),
      settings,
    });
  })
);

// ------------------------------------------------------------- resources ----

const RESOURCE_COLUMNS = [
  'skill_id', 'provider', 'external_id', 'title', 'url', 'instructor', 'headline',
  'image_url', 'price_cents', 'currency', 'rating', 'reviews', 'students',
  'duration_minutes', 'level', 'hidden', 'pinned', 'pre_tracked',
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
    const resource = get<{ id: number; url: string; title: string; pre_tracked: number }>(
      'SELECT id, url, title, pre_tracked FROM learning_resources WHERE id = ?',
      [id]
    );
    if (!resource) throw notFound('Resource');

    // A link that already carries its own tracking is sent on untouched.
    // Decorating it would point one redirector at another, which breaks the
    // attribution rather than doubling it.
    const link = resource.pre_tracked
      ? (() => {
          const safe = safeOutboundUrl(resource.url);
          return safe ? { url: safe, network: 'pasted', tracked: true } : null;
        })()
      : buildAffiliateUrl(resource.url, affiliateConfig(), {
          subId: subIdForResource(resource.id),
        });
    if (!link) throw badRequest('This resource has no usable URL');

    run(
      `INSERT INTO affiliate_clicks (resource_id, plan_item_id, network, target_url)
       VALUES (?, ?, ?, ?)`,
      [id, toInt(req.query.plan_item_id, 0) || null, link.tracked ? link.network : '', link.url]
    );
    res.redirect(302, link.url);
  })
);

/**
 * Bulk-add courses from a pasted block.
 *
 * The realistic way a catalogue gets filled: you have a shortlist in a
 * spreadsheet or a notes file, not one URL at a time in a modal. Lines name a
 * skill by code or by name, so a paste can cover every skill in one go.
 *
 * Nothing here talks to Udemy. Without the API there is no metadata to fetch,
 * so an untitled line falls back to the course slug and stays editable rather
 * than having a title invented for it.
 */
skillsRouter.post(
  '/learning-resources/bulk',
  wrap((req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) throw badRequest('Nothing to import');
    const defaultSkillId = toInt(req.body?.skill_id, 0) || null;

    const lines = parseBulkCourseLines(text);
    if (!lines.length) throw badRequest('No lines with a URL in them');

    const imported: Array<{
      url: string;
      skill: string | null;
      title: string;
      warnings: Array<{ code: string; message: string; severity: string }>;
    }> = [];
    const skipped: Array<{ line: string; reason: string }> = [];

    db.transaction(() => {
      for (const line of lines) {
        const url = normaliseUdemyUrl(line.url);
        if (!url) {
          skipped.push({ line: line.url, reason: 'not a Udemy course URL' });
          continue;
        }
        const slug = udemyCourseSlug(url);
        if (!slug) {
          skipped.push({ line: line.url, reason: 'no course slug in the URL' });
          continue;
        }

        // A skill reference matches on code first, then on name - a paste is
        // as likely to say "SEO" as "starter:seo".
        let skillId = defaultSkillId;
        if (line.skillRef) {
          const found =
            scalar<number>('SELECT id FROM skills WHERE code = ?', [line.skillRef], 0) ||
            scalar<number>(
              'SELECT id FROM skills WHERE lower(name) = lower(?) AND archived = 0',
              [line.skillRef],
              0
            );
          if (!found) {
            skipped.push({ line: line.url, reason: `unknown skill "${line.skillRef}"` });
            continue;
          }
          skillId = found;
        }

        const title = line.title || slug.replace(/-/g, ' ');
        saveCourse(skillId, {
          external_id: slug,
          title,
          url,
          instructor: '',
          headline: '',
          image_url: '',
          price_cents: 0,
          currency: 'USD',
          rating: 0,
          reviews: 0,
          students: 0,
          duration_minutes: 0,
          level: '',
        });
        imported.push({
          url,
          skill: skillId ? scalar<string>('SELECT name FROM skills WHERE id = ?', [skillId], '') : null,
          title,
          warnings: classifyReferenceUrl(url).warnings.filter((w) => w.severity === 'warning'),
        });
      }
    })();

    logActivity('learning_resources', null, 'create', `bulk import: ${imported.length} course(s)`);
    // "imported", not "added": a course already in the catalogue is updated in
    // place, so a re-run of the same paste creates nothing new.
    res.status(201).json({
      imported: imported.length,
      skipped: skipped.length,
      items: imported,
      errors: skipped,
    });
  })
);

/**
 * Check that catalogued course URLs still resolve.
 *
 * A dead affiliate link earns nothing and costs the reader's trust, and course
 * pages do get retired. This runs from your own server, against the plain
 * course URL rather than the tracked one, so it never registers a click.
 */
skillsRouter.post(
  '/learning-resources/check',
  wrap(async (req, res) => {
    const skillId = toInt(req.body?.skill_id, 0);
    const rows = all<{ id: number; url: string; title: string }>(
      `SELECT id, url, title FROM learning_resources
        WHERE url != '' ${skillId ? 'AND skill_id = ?' : ''}
        ORDER BY id LIMIT 200`,
      skillId ? [skillId] : []
    );

    const results: Array<{ id: number; title: string; status: number; ok: boolean }> = [];
    // Sequential and unhurried: this is a housekeeping job against someone
    // else's site, not a crawl to be finished as fast as possible.
    for (const row of rows) {
      let status = 0;
      try {
        const response = await fetch(row.url, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'user-agent': config.userAgent, accept: 'text/html,*/*' },
          signal: AbortSignal.timeout(12_000),
        });
        status = response.status;
      } catch {
        status = 0;
      }
      run(
        `UPDATE learning_resources SET checked_at = datetime('now'), check_status = ? WHERE id = ?`,
        [status, row.id]
      );
      results.push({ id: row.id, title: row.title, status, ok: status >= 200 && status < 400 });
    }

    res.json({
      checked: results.length,
      dead: results.filter((r) => !r.ok).length,
      items: results,
    });
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
        // Detected rather than assumed, and only when the caller has not said
        // either way - a paste of an already-tracked link is the common case
        // and silently double-wrapping it would be the damaging one.
        if (data.pre_tracked === undefined) data.pre_tracked = looksPreTracked(safe) ? 1 : 0;
      }
    },
    hydrate: (row) => {
      const link = row.pre_tracked ? null : buildAffiliateUrl(row.url, affiliateConfig());
      return {
        ...row,
        // The tracked URL is never handed to the browser directly: the click
        // goes through /go so it lands in the click log.
        go_url: `/api/learning-resources/${row.id}/go`,
        affiliate_network: row.pre_tracked ? 'pasted' : link?.tracked ? link.network : '',
        clicks: scalar<number>(
          'SELECT COUNT(*) FROM affiliate_clicks WHERE resource_id = ?',
          [row.id],
          0
        ),
        link_ok: row.checked_at ? row.check_status >= 200 && row.check_status < 400 : null,
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

      // Earnings, only present once conversions have been synced from the
      // network. Approved and pending are reported apart on purpose: a pending
      // action is not money yet, and a reversed one is money taken back, so a
      // single "revenue" figure would overstate what you have actually earned.
      earnings: {
        synced: scalar<number>('SELECT COUNT(*) FROM affiliate_actions', [], 0),
        last_sync: scalar<string>('SELECT MAX(synced_at) FROM affiliate_actions', [], ''),
        approved_cents: scalar<number>(
          `SELECT COALESCE(SUM(payout_cents), 0) FROM affiliate_actions
            WHERE state = 'APPROVED' AND event_date >= date('now', ?)`,
          [since],
          0
        ),
        pending_cents: scalar<number>(
          `SELECT COALESCE(SUM(payout_cents), 0) FROM affiliate_actions
            WHERE state = 'PENDING' AND event_date >= date('now', ?)`,
          [since],
          0
        ),
        reversed_cents: scalar<number>(
          `SELECT COALESCE(SUM(payout_cents), 0) FROM affiliate_actions
            WHERE state = 'REVERSED' AND event_date >= date('now', ?)`,
          [since],
          0
        ),
        unattributed: scalar<number>(
          `SELECT COUNT(*) FROM affiliate_actions WHERE resource_id IS NULL`,
          [],
          0
        ),
        by_skill: all(
          `SELECT s.id, s.name AS skill_name,
                  COUNT(a.id) AS conversions,
                  COALESCE(SUM(CASE WHEN a.state = 'APPROVED' THEN a.payout_cents ELSE 0 END), 0) AS approved_cents,
                  COALESCE(SUM(CASE WHEN a.state = 'PENDING'  THEN a.payout_cents ELSE 0 END), 0) AS pending_cents
             FROM affiliate_actions a
             JOIN skills s ON s.id = a.skill_id
            WHERE a.event_date >= date('now', ?)
            GROUP BY s.id ORDER BY approved_cents DESC, conversions DESC LIMIT 25`,
          [since]
        ),
      },
    });
  })
);

// ----------------------------------------------------------------- impact ---

/** Catalogues the Impact account can see, so one can be picked to import from. */
skillsRouter.get(
  '/impact/catalogs',
  wrap(async (_req, res) => {
    const credentials = impactCredentials();
    if (!credentials) {
      return res.json({ items: [], error: 'No Impact credentials configured', configured: false });
    }
    const outcome = await listCatalogs(credentials);
    res.json({ items: outcome.items, error: outcome.error ?? null, configured: true });
  })
);

/**
 * Import courses out of an Impact product catalogue.
 *
 * This is the path that needs no Udemy API at all: where the advertiser
 * publishes a feed, it already carries the titles, prices and URLs the
 * catalogue wants.
 *
 * Items are stored against the plain destination URL like every other course,
 * so they pick up tracking at click time rather than arriving pre-wrapped.
 */
skillsRouter.post(
  '/impact/catalog-import',
  wrap(async (req, res) => {
    const credentials = impactCredentials();
    if (!credentials) throw badRequest('No Impact credentials configured');

    const catalogId = String(req.body?.catalog_id ?? '').trim();
    if (!catalogId) throw badRequest('catalog_id is required');

    const skillId = toInt(req.body?.skill_id, 0) || null;
    const skill = skillId
      ? get<{ name: string; search_terms: string }>(
          'SELECT name, search_terms FROM skills WHERE id = ?',
          [skillId]
        )
      : null;
    // Default the query to the skill being filled, so an import aimed at one
    // skill does not drag in the advertiser's entire catalogue.
    const query = String(
      req.body?.query ?? [skill?.name, skill?.search_terms].filter(Boolean).join(' ')
    ).trim();

    const outcome = await listCatalogItems(credentials, catalogId, {
      query: query || undefined,
      maxPages: Math.min(Math.max(toInt(req.body?.max_pages, 2), 1), 10),
    });

    const limit = Math.min(Math.max(toInt(req.body?.limit, 25), 1), 200);
    const imported: Array<{ title: string; url: string }> = [];
    const skipped: Array<{ title: string; reason: string }> = [];

    db.transaction(() => {
      for (const item of outcome.items.slice(0, limit)) {
        const url = normaliseUdemyUrl(item.url);
        if (!url) {
          skipped.push({ title: item.name, reason: 'not a Udemy course URL' });
          continue;
        }
        const slug = udemyCourseSlug(url);
        if (!slug) {
          skipped.push({ title: item.name, reason: 'no course slug in the URL' });
          continue;
        }
        saveCourse(skillId, {
          external_id: slug,
          title: item.name,
          url,
          instructor: '',
          headline: item.description.slice(0, 300),
          image_url: item.imageUrl,
          price_cents: item.priceCents,
          currency: item.currency,
          rating: 0,
          reviews: 0,
          students: 0,
          duration_minutes: 0,
          level: '',
        });
        imported.push({ title: item.name, url });
      }
    })();

    logActivity('learning_resources', null, 'create', `Impact catalog import: ${imported.length}`);
    res.json({
      query,
      returned: outcome.items.length,
      imported: imported.length,
      skipped: skipped.length,
      items: imported,
      errors: skipped,
      error: outcome.error ?? null,
    });
  })
);

/**
 * Pull conversions back from Impact.
 *
 * Actions carry the SubId1 Helm stamped on the outbound link, which is what
 * lets a payout land against the skill that earned it instead of in one
 * undifferentiated total. An action whose sub id Helm does not recognise is
 * still stored - it is real money, it just cannot be attributed, and dropping
 * it would understate earnings.
 */
skillsRouter.post(
  '/impact/sync-actions',
  wrap(async (req, res) => {
    const credentials = impactCredentials();
    if (!credentials) throw badRequest('No Impact credentials configured');

    const days = Math.min(Math.max(toInt(req.body?.days, 90), 1), 730);
    const end = new Date();
    const start = new Date(end.getTime() - days * 864e5);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const outcome = await listActions(credentials, {
      startDate: iso(start),
      endDate: iso(end),
    });

    let stored = 0;
    let attributed = 0;

    db.transaction(() => {
      for (const action of outcome.items) {
        const resourceId = resourceIdFromSubId(action.subId);
        // Only trust the tag if the row it names still exists.
        const resource = resourceId
          ? get<{ id: number; skill_id: number | null }>(
              'SELECT id, skill_id FROM learning_resources WHERE id = ?',
              [resourceId]
            )
          : null;
        if (resource) attributed += 1;

        run(
          `INSERT INTO affiliate_actions
             (external_id, network, resource_id, skill_id, campaign, state, event_date,
              sale_cents, payout_cents, currency, sub_id, synced_at)
           VALUES (?, 'impact', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(external_id) DO UPDATE SET
             resource_id = excluded.resource_id, skill_id = excluded.skill_id,
             state = excluded.state, event_date = excluded.event_date,
             sale_cents = excluded.sale_cents, payout_cents = excluded.payout_cents,
             currency = excluded.currency, synced_at = excluded.synced_at`,
          [
            action.externalId, resource?.id ?? null, resource?.skill_id ?? null,
            action.campaign, action.state, action.eventDate, action.saleCents,
            action.payoutCents, action.currency, action.subId,
          ]
        );
        stored += 1;
      }
    })();

    logActivity('affiliate_actions', null, 'update', `Impact sync: ${stored} action(s)`);
    res.json({
      days,
      fetched: outcome.items.length,
      stored,
      attributed,
      unattributed: stored - attributed,
      error: outcome.error ?? null,
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
            ORDER BY pinned DESC, rating DESC, reviews DESC, id ASC LIMIT 1`,
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
