import { Router } from 'express';
import { all, get, run } from '../db.js';
import { crud } from '../lib/crud.js';
import { badRequest, notFound, parseJson, toInt, wrap } from '../lib/http.js';
import { PROVIDERS } from '../services/social/providers.js';
import { publishPost, recomputePostStatus } from '../services/social/publisher.js';

export const socialRouter = Router();

/** Provider catalogue for the composer and the account form. */
socialRouter.get(
  '/social-providers',
  wrap((_req, res) => {
    res.json({
      items: Object.values(PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        charLimit: p.charLimit,
        credentialFields: p.credentialFields,
      })),
    });
  })
);

socialRouter.use(
  '/social-accounts',
  crud({
    table: 'social_accounts',
    columns: ['platform', 'handle', 'display_name', 'credential_id', 'config_json', 'enabled'],
    required: ['platform'],
    filters: ['platform', 'enabled'],
    search: ['handle', 'display_name'],
    orderBy: 'platform ASC, handle ASC',
    describe: (r) => `${r?.platform} ${r?.handle}`,
    hydrate: (row) => ({
      ...row,
      config: parseJson<Record<string, any>>(row.config_json, {}),
      provider_label: PROVIDERS[row.platform]?.label ?? row.platform,
      char_limit: PROVIDERS[row.platform]?.charLimit ?? 500,
      has_credential: !!row.credential_id,
    }),
    beforeWrite: (data) => {
      if (data.config_json && typeof data.config_json !== 'string') {
        data.config_json = JSON.stringify(data.config_json);
      }
    },
  })
);

function targetsFor(postId: number) {
  return all(
    `SELECT t.*, a.platform, a.handle, a.display_name
       FROM social_post_targets t
       JOIN social_accounts a ON a.id = t.account_id
      WHERE t.post_id = ? ORDER BY a.platform`,
    [postId]
  );
}

/** Replace a post's target set with the given account ids. */
function syncTargets(postId: number, accountIds: number[]) {
  const existing = all<{ id: number; account_id: number; status: string }>(
    'SELECT id, account_id, status FROM social_post_targets WHERE post_id = ?',
    [postId]
  );
  const keep = new Set(accountIds);
  for (const row of existing) {
    // Never drop a target that already went out - the post really happened.
    if (!keep.has(row.account_id) && row.status !== 'published') {
      run('DELETE FROM social_post_targets WHERE id = ?', [row.id]);
    }
  }
  for (const accountId of accountIds) {
    run(
      'INSERT OR IGNORE INTO social_post_targets (post_id, account_id) VALUES (?, ?)',
      [postId, accountId]
    );
  }
}

socialRouter.use(
  '/social-posts',
  crud({
    table: 'social_posts',
    columns: ['body', 'media_json', 'link', 'campaign', 'status', 'scheduled_at', 'published_at'],
    filters: ['status', 'campaign'],
    search: ['body', 'campaign'],
    orderBy: `COALESCE(scheduled_at, created_at) DESC`,
    sortable: ['scheduled_at', 'created_at', 'status', 'id'],
    describe: (r) => String(r?.body ?? '').slice(0, 60),
    hydrate: (row) => ({
      ...row,
      media: parseJson<string[]>(row.media_json, []),
      targets: targetsFor(row.id),
    }),
    beforeWrite: (data, req) => {
      if (data.media_json && typeof data.media_json !== 'string') {
        data.media_json = JSON.stringify(data.media_json);
      }
      // Scheduling is implied by giving a post a future time.
      if (data.scheduled_at && !data.status && !req.body?.status) data.status = 'scheduled';
      data.updated_at = new Date().toISOString();
    },
    afterWrite: (row, action, req) => {
      if (action === 'delete' || !row) return;
      const ids = req.body?.account_ids;
      if (Array.isArray(ids)) {
        syncTargets(row.id, ids.map((v: unknown) => toInt(v)).filter(Boolean));
      }
    },
  })
);

socialRouter.get(
  '/social-posts/:id/targets',
  wrap((req, res) => res.json({ items: targetsFor(toInt(req.params.id)) }))
);

/** Publish now (or flush a scheduled post early). */
socialRouter.post(
  '/social-posts/:id/publish',
  wrap(async (req, res) => {
    const id = toInt(req.params.id);
    const post = get('SELECT id FROM social_posts WHERE id = ?', [id]);
    if (!post) throw notFound('Post');
    const results = await publishPost(id, { retryFailed: !!req.body?.retry });
    res.json({
      results,
      post: get('SELECT * FROM social_posts WHERE id = ?', [id]),
      targets: targetsFor(id),
    });
  })
);

/** Confirm a manual/copy-paste post actually went out. */
socialRouter.post(
  '/social-post-targets/:id/mark-published',
  wrap((req, res) => {
    const id = toInt(req.params.id);
    const target = get<any>('SELECT * FROM social_post_targets WHERE id = ?', [id]);
    if (!target) throw notFound('Target');
    run(
      `UPDATE social_post_targets
          SET status = 'published', error = '', remote_url = ?, published_at = datetime('now')
        WHERE id = ?`,
      [req.body?.remote_url ?? target.remote_url ?? '', id]
    );
    recomputePostStatus(target.post_id);
    res.json(get('SELECT * FROM social_post_targets WHERE id = ?', [id]));
  })
);

socialRouter.use(
  '/social-metrics',
  crud({
    table: 'social_metrics',
    columns: ['target_id', 'captured_at', 'likes', 'shares', 'comments', 'impressions'],
    required: ['target_id'],
    filters: ['target_id'],
    orderBy: 'captured_at DESC',
  })
);

/** Scheduled posts in a date window, for the calendar view. */
socialRouter.get(
  '/social-calendar',
  wrap((req, res) => {
    const from = String(req.query.from ?? '').slice(0, 10);
    const to = String(req.query.to ?? '').slice(0, 10);
    if (!from || !to) throw badRequest('from and to (YYYY-MM-DD) are required');
    const items = all(
      `SELECT * FROM social_posts
        WHERE scheduled_at IS NOT NULL AND date(scheduled_at) BETWEEN ? AND ?
        ORDER BY scheduled_at`,
      [from, to]
    );
    res.json({
      items: items.map((row: any) => ({ ...row, targets: targetsFor(row.id) })),
    });
  })
);

/** Queue health: what is coming up and what needs a human. */
socialRouter.get(
  '/social-queue',
  wrap((_req, res) => {
    res.json({
      upcoming: all(
        `SELECT * FROM social_posts
          WHERE status = 'scheduled' AND scheduled_at IS NOT NULL
          ORDER BY scheduled_at LIMIT 25`
      ).map((row: any) => ({ ...row, targets: targetsFor(row.id) })),
      needsAttention: all(
        `SELECT DISTINCT p.* FROM social_posts p
           JOIN social_post_targets t ON t.post_id = p.id
          WHERE t.status IN ('failed', 'manual_required')
          ORDER BY p.scheduled_at DESC LIMIT 25`
      ).map((row: any) => ({ ...row, targets: targetsFor(row.id) })),
      drafts: all(`SELECT * FROM social_posts WHERE status = 'draft' ORDER BY updated_at DESC LIMIT 25`),
    });
  })
);
