import { Router } from 'express';
import crypto from 'node:crypto';
import { all, get, getSetting, logActivity, run, setSetting } from '../db.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { badRequest, requireFields, wrap } from '../lib/http.js';
import {
  OAUTH2_PROVIDERS,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  getOAuth2Config,
  redirectUri,
  validateAppKeys,
} from '../services/social/oauth2.js';
import { resolveIdentity } from '../services/social/networks.js';

export const oauthRouter = Router();

const STATE_PREFIX = 'oauth_state:';
const STATE_TTL_MS = 10 * 60_000;

/** Client id/secret for a provider's app, stored encrypted like any credential. */
export function appCreds(providerId: string): { clientId: string; clientSecret: string } | null {
  const row = get<{ data_enc: string }>(
    'SELECT data_enc FROM credentials WHERE service = ? ORDER BY id DESC LIMIT 1',
    [`app:${providerId}`]
  );
  if (!row) return null;
  try {
    const data = decryptJson<Record<string, string>>(row.data_enc);
    if (!data.client_id || !data.client_secret) return null;
    return { clientId: data.client_id, clientSecret: data.client_secret };
  } catch {
    return null;
  }
}

/** What the UI needs to render the connect screen. */
oauthRouter.get(
  '/providers',
  wrap((_req, res) => {
    res.json({
      items: Object.values(OAUTH2_PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        note: p.note,
        scopes: p.scopes,
        configured: !!appCreds(p.id),
        redirectUri: redirectUri(p.id),
        clientIdLabel: p.clientIdParam ?? 'client_id',
        clientIdHint: p.clientIdHint,
        clientSecretHint: p.clientSecretHint,
      })),
    });
  })
);

/** Save the app's client id/secret from the developer portal. */
oauthRouter.post(
  '/app/:provider',
  wrap((req, res) => {
    const provider = getOAuth2Config(req.params.provider);
    requireFields(req.body ?? {}, ['client_id', 'client_secret']);
    const invalid = validateAppKeys(provider, req.body.client_id, req.body.client_secret);
    if (invalid) throw badRequest(invalid);
    // One app record per provider - replace rather than accumulate.
    run('DELETE FROM credentials WHERE service = ?', [`app:${provider.id}`]);
    run('INSERT INTO credentials (service, label, data_enc) VALUES (?, ?, ?)', [
      `app:${provider.id}`,
      `${provider.label} app`,
      encryptJson({
        client_id: String(req.body.client_id).trim(),
        client_secret: String(req.body.client_secret).trim(),
      }),
    ]);
    res.status(201).json({ ok: true, redirectUri: redirectUri(provider.id) });
  })
);

oauthRouter.delete(
  '/app/:provider',
  wrap((req, res) => {
    const provider = getOAuth2Config(req.params.provider);
    run('DELETE FROM credentials WHERE service = ?', [`app:${provider.id}`]);
    res.status(204).end();
  })
);

/** Kick off the browser flow. The client navigates here directly. */
oauthRouter.get(
  '/:provider/start',
  wrap((req, res) => {
    const provider = getOAuth2Config(req.params.provider);
    const app = appCreds(provider.id);
    if (!app) {
      throw badRequest(
        `No ${provider.label} app configured yet. Add its client id and secret in Settings first.`
      );
    }
    const state = crypto.randomBytes(24).toString('hex');
    const pkce = provider.usesPkce ? createPkcePair() : null;
    setSetting(`${STATE_PREFIX}${state}`, {
      provider: provider.id,
      verifier: pkce?.verifier ?? null,
      createdAt: Date.now(),
    });
    res.redirect(buildAuthorizeUrl(provider, app.clientId, state, pkce?.challenge));
  })
);

/** Where the provider sends the user back. */
oauthRouter.get(
  '/:provider/callback',
  wrap(async (req, res) => {
    const provider = getOAuth2Config(req.params.provider);
    const fail = (message: string) =>
      res.redirect(`/social?connect_error=${encodeURIComponent(message)}`);

    if (req.query.error) {
      return fail(String(req.query.error_description ?? req.query.error));
    }

    const state = String(req.query.state ?? '');
    const stored = getSetting<any>(`${STATE_PREFIX}${state}`, null);
    // A missing or stale state means this callback was not one we started.
    if (!stored || stored.provider !== provider.id) return fail('Invalid or expired OAuth state.');
    run('DELETE FROM settings WHERE key = ?', [`${STATE_PREFIX}${state}`]);
    if (Date.now() - stored.createdAt > STATE_TTL_MS) return fail('That login attempt expired - try again.');

    const app = appCreds(provider.id);
    if (!app) return fail(`No ${provider.label} app is configured.`);

    try {
      const tokens = await exchangeCode(provider, {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        code: String(req.query.code ?? ''),
        codeVerifier: stored.verifier ?? undefined,
      });

      // Google is not a posting target - it backs the SEO module instead, so it
      // stores a credential and returns to the SEO page rather than creating a
      // social account.
      if (provider.id === 'google') {
        run(`DELETE FROM credentials WHERE service = 'google'`);
        run('INSERT INTO credentials (service, label, data_enc) VALUES (?, ?, ?)', [
          'google',
          'Google Search Console',
          encryptJson(tokens),
        ]);
        logActivity('seo_sites', null, 'connect', 'Google Search Console');
        return res.redirect('/seo?connected=Google%20Search%20Console');
      }

      const identity = await resolveIdentity(provider.id, tokens, app);

      const credentialId = Number(
        run('INSERT INTO credentials (service, label, data_enc) VALUES (?, ?, ?)', [
          provider.id,
          identity.displayName,
          encryptJson({ ...tokens, ...identity.extraCreds }),
        ]).lastInsertRowid
      );

      // Reuse the existing account row for this platform if there is one, so
      // reconnecting refreshes credentials instead of creating a duplicate.
      const existing = get<{ id: number; credential_id: number | null }>(
        'SELECT id, credential_id FROM social_accounts WHERE platform = ? ORDER BY id LIMIT 1',
        [provider.id]
      );
      if (existing) {
        run(
          `UPDATE social_accounts SET handle = ?, display_name = ?, credential_id = ?,
                  config_json = ?, enabled = 1 WHERE id = ?`,
          [
            identity.handle,
            identity.displayName,
            credentialId,
            JSON.stringify(identity.accountConfig),
            existing.id,
          ]
        );
        if (existing.credential_id) {
          run('DELETE FROM credentials WHERE id = ?', [existing.credential_id]);
        }
      } else {
        run(
          `INSERT INTO social_accounts (platform, handle, display_name, credential_id, config_json, enabled)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [
            provider.id,
            identity.handle,
            identity.displayName,
            credentialId,
            JSON.stringify(identity.accountConfig),
          ]
        );
      }

      logActivity('social_accounts', null, 'connect', `${provider.label}: ${identity.displayName}`);
      res.redirect(`/social?connected=${encodeURIComponent(provider.label)}`);
    } catch (err: any) {
      return fail(String(err?.message ?? err).slice(0, 300));
    }
  })
);

/** Housekeeping: drop OAuth states that were never completed. */
export function purgeOAuthStates() {
  const rows = all<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings WHERE key LIKE 'oauth_state:%'"
  );
  for (const row of rows) {
    try {
      const value = JSON.parse(row.value_json);
      if (Date.now() - (value?.createdAt ?? 0) > STATE_TTL_MS) {
        run('DELETE FROM settings WHERE key = ?', [row.key]);
      }
    } catch {
      run('DELETE FROM settings WHERE key = ?', [row.key]);
    }
  }
}
