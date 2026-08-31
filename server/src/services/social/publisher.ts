import { all, get, logActivity, run } from '../../db.js';
import { decryptJson, encryptJson } from '../../lib/crypto.js';
import { parseJson } from '../../lib/http.js';
import { getProvider, OAUTH_PROVIDER_IDS } from './providers.js';
import { getOAuth2Config, needsRefresh, refreshTokens } from './oauth2.js';
import { appCreds } from '../../routes/oauth.js';

export type TargetStatus = 'pending' | 'published' | 'failed' | 'manual_required';

const MAX_ATTEMPTS = 3;

/**
 * Decrypt an account's credentials, refreshing the access token first when it
 * is expired or nearly so. A refreshed token is written back immediately, so
 * one refresh serves every later publish.
 */
async function credsFor(account: any): Promise<Record<string, string>> {
  if (!account.credential_id) return {};
  const row = get<{ data_enc: string }>('SELECT data_enc FROM credentials WHERE id = ?', [
    account.credential_id,
  ]);
  if (!row) return {};

  let creds: Record<string, any>;
  try {
    creds = decryptJson<Record<string, any>>(row.data_enc);
  } catch {
    throw new Error('Stored credential could not be decrypted (has HELM_SECRET changed?)');
  }

  const isOAuth = OAUTH_PROVIDER_IDS.includes(account.platform);
  if (!isOAuth || !creds.refresh_token || !needsRefresh(creds)) return creds;

  const app = appCreds(account.platform);
  if (!app) return creds;

  try {
    const provider = getOAuth2Config(account.platform);
    const fresh = await refreshTokens(provider, {
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: creds.refresh_token,
    });
    // Providers often omit unchanged fields; merge rather than replace.
    const merged = { ...creds, ...fresh };
    run('UPDATE credentials SET data_enc = ? WHERE id = ?', [
      encryptJson(merged),
      account.credential_id,
    ]);
    logActivity('social_accounts', account.account_id ?? null, 'token_refresh', account.platform);
    return merged;
  } catch (err) {
    throw new Error(
      `${account.platform} access token expired and could not be refreshed - reconnect the account. (${String(
        (err as Error)?.message ?? err
      ).slice(0, 120)})`
    );
  }
}

/** Roll the per-target outcomes up into a single post status. */
export function recomputePostStatus(postId: number) {
  const targets = all<{ status: string }>(
    'SELECT status FROM social_post_targets WHERE post_id = ?',
    [postId]
  );
  if (!targets.length) return;
  const count = (s: string) => targets.filter((t) => t.status === s).length;
  const published = count('published');
  const failed = count('failed');
  const manual = count('manual_required');
  const total = targets.length;

  let status: string;
  if (published === total) status = 'published';
  else if (failed === total) status = 'failed';
  else if (published + failed + manual === total && published > 0) status = 'partial';
  else if (published + failed + manual === total) status = 'partial';
  else status = published > 0 ? 'partial' : 'scheduled';

  run(
    `UPDATE social_posts
        SET status = ?,
            published_at = CASE WHEN ? IN ('published','partial') THEN COALESCE(published_at, datetime('now')) ELSE published_at END,
            updated_at = datetime('now')
      WHERE id = ?`,
    [status, status, postId]
  );
}

/**
 * Push one post to every target that has not succeeded yet.
 * Returns a per-target report; never throws for a single provider failure.
 */
export async function publishPost(postId: number, opts: { retryFailed?: boolean } = {}) {
  const post = get<any>('SELECT * FROM social_posts WHERE id = ?', [postId]);
  if (!post) throw new Error(`Post ${postId} not found`);

  const statuses = opts.retryFailed ? ['pending', 'failed'] : ['pending'];
  const targets = all<any>(
    `SELECT t.*, a.platform, a.handle, a.config_json, a.credential_id, a.enabled
       FROM social_post_targets t
       JOIN social_accounts a ON a.id = t.account_id
      WHERE t.post_id = ? AND t.status IN (${statuses.map(() => '?').join(',')})`,
    [postId, ...statuses]
  );

  const results: Array<{ targetId: number; status: TargetStatus; message: string }> = [];

  for (const target of targets) {
    if (!target.enabled) {
      results.push({ targetId: target.id, status: 'pending', message: 'account disabled - skipped' });
      continue;
    }
    if (target.attempts >= MAX_ATTEMPTS && !opts.retryFailed) {
      results.push({ targetId: target.id, status: 'failed', message: 'max attempts reached' });
      continue;
    }

    try {
      const provider = getProvider(target.platform);
      const accountConfig = parseJson<Record<string, any>>(target.config_json, {});

      if (provider.id === 'manual') {
        run(
          `UPDATE social_post_targets SET status = 'manual_required', attempts = attempts + 1, error = '' WHERE id = ?`,
          [target.id]
        );
        results.push({
          targetId: target.id,
          status: 'manual_required',
          message: 'Awaiting manual posting',
        });
        continue;
      }

      const outcome = await provider.publish({
        body: target.body_override || post.body,
        link: post.link,
        media: parseJson<string[]>(post.media_json, []),
        creds: await credsFor(target),
        accountConfig,
      });

      run(
        `UPDATE social_post_targets
            SET status = 'published', remote_id = ?, remote_url = ?, error = '',
                attempts = attempts + 1, published_at = datetime('now')
          WHERE id = ?`,
        [outcome.remoteId, outcome.remoteUrl, target.id]
      );
      results.push({ targetId: target.id, status: 'published', message: outcome.remoteUrl });
      logActivity('social_posts', postId, 'publish', `${target.platform} ${target.handle}`);
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 500);
      run(
        `UPDATE social_post_targets
            SET status = 'failed', error = ?, attempts = attempts + 1
          WHERE id = ?`,
        [message, target.id]
      );
      results.push({ targetId: target.id, status: 'failed', message });
      logActivity('social_posts', postId, 'publish_failed', `${target.platform}: ${message}`);
    }
  }

  recomputePostStatus(postId);
  return results;
}

/** Everything whose scheduled time has arrived. Called by the scheduler tick. */
export function duePostIds(): number[] {
  return all<{ id: number }>(
    `SELECT id FROM social_posts
      WHERE status IN ('scheduled', 'partial')
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= datetime('now')`
  ).map((r) => r.id);
}
