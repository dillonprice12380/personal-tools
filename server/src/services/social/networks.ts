import { config } from '../../config.js';
import { authorizationHeader, type OAuth1Credentials } from './oauth1.js';
import type { Provider, PublishContext, PublishResult } from './providers.js';

/**
 * The mainstream networks. Each one is awkward in its own way:
 *
 *  - X signs with OAuth 1.0a using tokens you issue yourself, so there is no
 *    browser flow at all.
 *  - LinkedIn posts as a member URN resolved at connect time.
 *  - Facebook posts to a Page, never a personal profile - Meta removed that.
 *  - Instagram is a two-step container/publish and *requires* media reachable
 *    at a public URL; it cannot post text alone.
 *  - TikTok is video only, and direct publishing needs an audited app.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

async function callJson(url: string, init: RequestInit = {}, label = 'API'): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': config.userAgent, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json?.error) {
    const err = json?.error;
    const detail =
      (typeof err === 'object' ? err?.message ?? err?.error_user_msg : err) ??
      json?.detail ??
      json?.title ??
      text.slice(0, 300);
    throw new Error(`${label} ${res.status}: ${detail}`);
  }
  return json;
}

function requireText(body: string, network: string) {
  if (!body.trim()) throw new Error(`${network} needs some text to post.`);
}

function withLink(body: string, link: string): string {
  if (!link) return body;
  return body.includes(link) ? body : `${body}\n\n${link}`.trim();
}

// ------------------------------------------------------------------- X ----
export const xProvider: Provider = {
  id: 'x',
  label: 'X (Twitter)',
  credentialFields: ['consumer_key', 'consumer_secret', 'access_token', 'access_token_secret'],
  charLimit: 280,
  async publish({ body, link, creds, accountConfig }: PublishContext): Promise<PublishResult> {
    const missing = ['consumer_key', 'consumer_secret', 'access_token', 'access_token_secret'].filter(
      (f) => !creds[f]
    );
    if (missing.length) throw new Error(`X is missing credential field(s): ${missing.join(', ')}`);
    const text = withLink(body, link);
    requireText(text, 'X');

    const url = 'https://api.twitter.com/2/tweets';
    // The JSON body is not part of an OAuth 1.0a signature base string, so only
    // the oauth_* parameters are signed here.
    const header = authorizationHeader('POST', url, creds as unknown as OAuth1Credentials);
    const json = await callJson(
      url,
      {
        method: 'POST',
        headers: { authorization: header, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      'X'
    );
    const id = json?.data?.id ?? '';
    const handle = String(accountConfig.handle ?? 'i/web').replace(/^@/, '');
    return { remoteId: id, remoteUrl: id ? `https://x.com/${handle}/status/${id}` : '' };
  },
};

// ------------------------------------------------------------ LinkedIn ----
export const linkedinProvider: Provider = {
  id: 'linkedin',
  label: 'LinkedIn',
  credentialFields: [],
  charLimit: 3000,
  async publish({ body, link, creds, accountConfig }: PublishContext): Promise<PublishResult> {
    if (!creds.access_token) throw new Error('LinkedIn is not connected - reconnect it in Settings.');
    const author = String(accountConfig.author_urn ?? '');
    if (!author) throw new Error('LinkedIn account is missing its member URN - reconnect it.');
    const text = withLink(body, link);
    requireText(text, 'LinkedIn');

    const res = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.access_token}`,
        'content-type': 'application/json',
        'user-agent': config.userAgent,
        // Versioned API: pinned so LinkedIn cannot change the contract underneath us.
        'LinkedIn-Version': String(accountConfig.api_version ?? '202405'),
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author,
        commentary: text,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`LinkedIn ${res.status}: ${detail.slice(0, 300)}`);
    }
    // The post URN comes back in a header, not the body.
    const urn = res.headers.get('x-restli-id') ?? '';
    return {
      remoteId: urn,
      remoteUrl: urn ? `https://www.linkedin.com/feed/update/${urn}` : '',
    };
  },
};

// ------------------------------------------------------------ Facebook ----
export const facebookProvider: Provider = {
  id: 'facebook',
  label: 'Facebook Page',
  credentialFields: [],
  charLimit: 63206,
  async publish({ body, link, creds, accountConfig }: PublishContext): Promise<PublishResult> {
    const pageId = String(accountConfig.page_id ?? '');
    const token = String(creds.page_access_token ?? creds.access_token ?? '');
    if (!pageId || !token) throw new Error('Facebook Page is not connected - reconnect it.');
    requireText(body, 'Facebook');

    const params = new URLSearchParams({ message: body, access_token: token });
    if (link) params.set('link', link);

    const json = await callJson(
      `${GRAPH}/${pageId}/feed`,
      { method: 'POST', body: params },
      'Facebook'
    );
    const id = String(json?.id ?? '');
    return { remoteId: id, remoteUrl: id ? `https://www.facebook.com/${id}` : '' };
  },
};

// ----------------------------------------------------------- Instagram ----
export const instagramProvider: Provider = {
  id: 'instagram',
  label: 'Instagram',
  credentialFields: [],
  charLimit: 2200,
  async publish({ body, link, media, creds, accountConfig }: PublishContext): Promise<PublishResult> {
    const igUserId = String(accountConfig.ig_user_id ?? '');
    const token = String(creds.page_access_token ?? creds.access_token ?? '');
    if (!igUserId || !token) throw new Error('Instagram is not connected - reconnect it.');

    const imageUrl = media?.[0];
    if (!imageUrl) {
      throw new Error(
        'Instagram requires an image or video. Add a publicly reachable media URL to the post - the API cannot accept a local file.'
      );
    }
    if (!/^https:\/\//i.test(imageUrl)) {
      throw new Error('Instagram media must be a public https:// URL that Meta can fetch.');
    }

    const isVideo = /\.(mp4|mov)(\?|$)/i.test(imageUrl);
    const caption = withLink(body, link);

    // Step 1: create a media container.
    const createParams = new URLSearchParams({ caption, access_token: token });
    if (isVideo) {
      createParams.set('media_type', 'REELS');
      createParams.set('video_url', imageUrl);
    } else {
      createParams.set('image_url', imageUrl);
    }
    const container = await callJson(
      `${GRAPH}/${igUserId}/media`,
      { method: 'POST', body: createParams },
      'Instagram (container)'
    );
    const creationId = String(container?.id ?? '');
    if (!creationId) throw new Error('Instagram did not return a media container id.');

    // Step 2: video containers need time to transcode before publishing.
    if (isVideo) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await callJson(
          `${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`,
          {},
          'Instagram (status)'
        );
        if (status?.status_code === 'FINISHED') break;
        if (status?.status_code === 'ERROR') throw new Error('Instagram failed to process the video.');
      }
    }

    const published = await callJson(
      `${GRAPH}/${igUserId}/media_publish`,
      {
        method: 'POST',
        body: new URLSearchParams({ creation_id: creationId, access_token: token }),
      },
      'Instagram (publish)'
    );
    const id = String(published?.id ?? '');

    let permalink = '';
    try {
      const detail = await callJson(
        `${GRAPH}/${id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
        {},
        'Instagram'
      );
      permalink = String(detail?.permalink ?? '');
    } catch {
      // The post is already live; a missing permalink is not a failure.
    }
    return { remoteId: id, remoteUrl: permalink };
  },
};

// -------------------------------------------------------------- TikTok ----
export const tiktokProvider: Provider = {
  id: 'tiktok',
  label: 'TikTok',
  credentialFields: [],
  charLimit: 2200,
  async publish({ body, link, media, creds, accountConfig }: PublishContext): Promise<PublishResult> {
    if (!creds.access_token) throw new Error('TikTok is not connected - reconnect it.');
    const videoUrl = media?.[0];
    if (!videoUrl) {
      throw new Error('TikTok requires a video. Add a publicly reachable video URL to the post.');
    }
    if (!/^https:\/\//i.test(videoUrl)) {
      throw new Error('TikTok media must be a public https:// URL that TikTok can fetch.');
    }

    // Direct posting requires an audited app; drafts work without that review.
    const direct = accountConfig.direct_post === true;
    const endpoint = direct
      ? 'https://open.tiktokapis.com/v2/post/publish/video/init/'
      : 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';

    const payload: Record<string, unknown> = {
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    };
    if (direct) {
      payload.post_info = {
        title: withLink(body, link).slice(0, 2200),
        privacy_level: String(accountConfig.privacy_level ?? 'SELF_ONLY'),
        disable_comment: false,
      };
    }

    const json = await callJson(
      endpoint,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.access_token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(payload),
      },
      'TikTok'
    );

    const publishId = String(json?.data?.publish_id ?? '');
    return {
      remoteId: publishId,
      remoteUrl: '',
      note: direct
        ? 'Sent to TikTok for direct publishing.'
        : 'Uploaded to your TikTok inbox - open the app to review and post it.',
    };
  },
};

// ------------------------------------------------- post-connect identity ---
export type ResolvedIdentity = {
  handle: string;
  displayName: string;
  /** Non-secret identifiers stored on the account row. */
  accountConfig: Record<string, unknown>;
  /** Secrets merged into the encrypted credential. */
  extraCreds: Record<string, string>;
};

/**
 * Meta's short-lived user token lasts about an hour. Exchanging it for a
 * long-lived one (~60 days) and deriving Page tokens from that is what makes
 * Page tokens effectively permanent.
 */
async function longLivedMetaToken(
  shortToken: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  try {
    const json = await callJson(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&client_secret=${encodeURIComponent(clientSecret)}` +
        `&fb_exchange_token=${encodeURIComponent(shortToken)}`,
      {},
      'Facebook (token exchange)'
    );
    return String(json?.access_token ?? shortToken);
  } catch {
    // Fall back to the short-lived token rather than failing the connection.
    return shortToken;
  }
}

async function metaPage(userToken: string, wantInstagram: boolean): Promise<ResolvedIdentity> {
  const fields = wantInstagram
    ? 'id,name,access_token,instagram_business_account'
    : 'id,name,access_token';
  const json = await callJson(
    `${GRAPH}/me/accounts?fields=${fields}&access_token=${encodeURIComponent(userToken)}`,
    {},
    'Facebook (pages)'
  );
  const pages: any[] = json?.data ?? [];
  if (!pages.length) {
    throw new Error(
      'No Facebook Pages found on this account. Posting requires a Page you administer - Meta does not allow API posts to personal profiles.'
    );
  }
  const page = wantInstagram
    ? pages.find((p) => p.instagram_business_account?.id) ?? pages[0]
    : pages[0];

  if (wantInstagram) {
    const igId = page?.instagram_business_account?.id;
    if (!igId) {
      throw new Error(
        'No Instagram Business account is linked to your Facebook Page. Convert the Instagram account to Business or Creator and link it to the Page, then reconnect.'
      );
    }
    return {
      handle: page.name ?? 'instagram',
      displayName: `Instagram via ${page.name ?? 'Page'}`,
      accountConfig: { ig_user_id: igId, page_id: page.id },
      extraCreds: { page_access_token: page.access_token },
    };
  }

  return {
    handle: page.name ?? 'facebook-page',
    displayName: page.name ?? 'Facebook Page',
    accountConfig: { page_id: page.id },
    extraCreds: { page_access_token: page.access_token },
  };
}

/** Work out who we just connected as, and what the publisher will need later. */
export async function resolveIdentity(
  providerId: string,
  tokens: Record<string, any>,
  app: { clientId: string; clientSecret: string }
): Promise<ResolvedIdentity> {
  if (providerId === 'linkedin') {
    const me = await callJson(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
      'LinkedIn (userinfo)'
    );
    if (!me?.sub) throw new Error('LinkedIn did not return a member id.');
    return {
      handle: me.name ?? me.email ?? 'linkedin',
      displayName: me.name ?? 'LinkedIn',
      accountConfig: { author_urn: `urn:li:person:${me.sub}` },
      extraCreds: {},
    };
  }

  if (providerId === 'facebook' || providerId === 'instagram') {
    const longLived = await longLivedMetaToken(tokens.access_token, app.clientId, app.clientSecret);
    const identity = await metaPage(longLived, providerId === 'instagram');
    return { ...identity, extraCreds: { ...identity.extraCreds, access_token: longLived } };
  }

  if (providerId === 'tiktok') {
    let displayName = 'TikTok';
    try {
      const me = await callJson(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
        { headers: { authorization: `Bearer ${tokens.access_token}` } },
        'TikTok (user info)'
      );
      displayName = me?.data?.user?.display_name ?? displayName;
    } catch {
      // user.info.basic may not be granted; the connection is still usable.
    }
    return {
      handle: displayName,
      displayName,
      accountConfig: { direct_post: false, privacy_level: 'SELF_ONLY' },
      extraCreds: {},
    };
  }

  return { handle: providerId, displayName: providerId, accountConfig: {}, extraCreds: {} };
}
