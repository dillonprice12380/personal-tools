import crypto from 'node:crypto';
import { config } from '../../config.js';
import { getSetting } from '../../db.js';

/**
 * Generic OAuth 2.0 authorization-code flow, shared by LinkedIn, Facebook,
 * Instagram and TikTok.
 *
 * The providers differ in small, awkward ways - TikTok names its client
 * credentials `client_key`/`client_secret` and posts them in the body, Meta
 * wants them on the query string - so each config declares its quirks rather
 * than the flow trying to guess.
 */
export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** Absolute ISO timestamp; absent when the provider issues no expiry. */
  expires_at?: string;
  scope?: string;
  /** Provider-specific identifiers resolved after connecting. */
  [key: string]: unknown;
};

export type OAuth2Config = {
  id: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** TikTok uses `client_key` instead of the usual `client_id`. */
  clientIdParam?: string;
  /** Extra parameters appended to the authorize URL. */
  extraAuthParams?: Record<string, string>;
  /** Some providers require PKCE (TikTok does). */
  usesPkce?: boolean;
  /** Where the token request puts its parameters. */
  tokenRequestIn?: 'body' | 'query';
  /** Human-readable note surfaced in the UI. */
  note?: string;
};

export const OAUTH2_PROVIDERS: Record<string, OAuth2Config> = {
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    // openid/profile identify the member; w_member_social allows posting.
    scopes: ['openid', 'profile', 'w_member_social'],
    tokenRequestIn: 'body',
    note: 'Requires the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products on your app.',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook Page',
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
    tokenRequestIn: 'query',
    note: 'Posts to a Page you administer. Personal profiles cannot be posted to via the API.',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: [
      'pages_show_list',
      'pages_read_engagement',
      'instagram_basic',
      'instagram_content_publish',
    ],
    tokenRequestIn: 'query',
    note: 'Needs an Instagram Business or Creator account linked to a Facebook Page. Every post must include media.',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    clientIdParam: 'client_key',
    usesPkce: true,
    tokenRequestIn: 'body',
    note: 'Video only. Direct publishing requires an audited app; unaudited apps can send drafts to your TikTok inbox.',
  },
};

export function getOAuth2Config(id: string): OAuth2Config {
  const provider = OAUTH2_PROVIDERS[id];
  if (!provider) throw new Error(`Unknown OAuth provider: ${id}`);
  return provider;
}

/**
 * The externally reachable base URL, used to build redirect URIs. It must match
 * what is registered with the provider exactly, so it is a setting rather than
 * something inferred per request.
 */
export function baseUrl(): string {
  return String(getSetting('publicUrl', `http://localhost:${config.port}`)).replace(/\/+$/, '');
}

export function redirectUri(providerId: string): string {
  return `${baseUrl()}/api/oauth/${providerId}/callback`;
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  provider: OAuth2Config,
  clientId: string,
  state: string,
  codeChallenge?: string
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set(provider.clientIdParam ?? 'client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(provider.id));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', provider.scopes.join(provider.id === 'tiktok' ? ',' : ' '));
  for (const [k, v] of Object.entries(provider.extraAuthParams ?? {})) url.searchParams.set(k, v);
  if (provider.usesPkce && codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

function expiresAt(seconds: unknown): string | undefined {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(Date.now() + n * 1000).toISOString();
}

async function tokenRequest(
  provider: OAuth2Config,
  params: Record<string, string>
): Promise<TokenSet> {
  let res: Response;
  if (provider.tokenRequestIn === 'query') {
    const url = new URL(provider.tokenUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res = await fetch(url, { headers: { 'user-agent': config.userAgent } });
  } else {
    res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': config.userAgent,
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${provider.label} returned a non-JSON token response: ${text.slice(0, 200)}`);
  }
  // TikTok reports failures with HTTP 200 and an `error` field.
  if (!res.ok || json.error) {
    const detail = json.error_description ?? json.error_message ?? json.error ?? text.slice(0, 200);
    throw new Error(`${provider.label} token request failed: ${detail}`);
  }

  const payload = json.data ?? json;
  return {
    ...payload,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAt(payload.expires_in),
    scope: payload.scope,
  };
}

export async function exchangeCode(
  provider: OAuth2Config,
  opts: { clientId: string; clientSecret: string; code: string; codeVerifier?: string }
): Promise<TokenSet> {
  const params: Record<string, string> = {
    [provider.clientIdParam ?? 'client_id']: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(provider.id),
  };
  if (provider.usesPkce && opts.codeVerifier) params.code_verifier = opts.codeVerifier;
  return tokenRequest(provider, params);
}

export async function refreshTokens(
  provider: OAuth2Config,
  opts: { clientId: string; clientSecret: string; refreshToken: string }
): Promise<TokenSet> {
  return tokenRequest(provider, {
    [provider.clientIdParam ?? 'client_id']: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
}

/** True when a token set is missing, expired, or within five minutes of it. */
export function needsRefresh(tokens: { expires_at?: string } | null | undefined): boolean {
  if (!tokens?.expires_at) return false;
  return new Date(tokens.expires_at).getTime() - Date.now() < 5 * 60_000;
}
