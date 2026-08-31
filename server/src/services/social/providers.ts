import { config } from '../../config.js';

export type PublishContext = {
  /** Final text to post (per-target override already applied). */
  body: string;
  link: string;
  media: string[];
  /** Decrypted credential payload for the account. */
  creds: Record<string, string>;
  /** Free-form per-account config (e.g. a Telegram chat id override). */
  accountConfig: Record<string, any>;
};

export type PublishResult = {
  remoteId: string;
  remoteUrl: string;
  /** Set when a provider intentionally does no network call. */
  note?: string;
};

export type Provider = {
  id: string;
  label: string;
  /** Credential fields this provider needs, for the Settings UI. */
  credentialFields: string[];
  /** Soft character budget used by the composer's counter. */
  charLimit: number;
  publish(ctx: PublishContext): Promise<PublishResult>;
};

/** Post text with the link appended when it is not already in the body. */
function withLink(body: string, link: string): string {
  if (!link) return body;
  return body.includes(link) ? body : `${body}\n\n${link}`.trim();
}

async function postJson(url: string, init: RequestInit & { timeoutMs?: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': config.userAgent,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const detail = json?.error ?? json?.message ?? text.slice(0, 200);
      throw new Error(`${res.status} ${res.statusText}: ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const mastodon: Provider = {
  id: 'mastodon',
  label: 'Mastodon',
  credentialFields: ['instance', 'access_token'],
  charLimit: 500,
  async publish({ body, link, creds }) {
    const instance = (creds.instance || '').replace(/\/+$/, '');
    if (!instance || !creds.access_token) throw new Error('Mastodon needs `instance` and `access_token`');
    const json = await postJson(`${instance}/api/v1/statuses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.access_token}` },
      body: JSON.stringify({ status: withLink(body, link) }),
    });
    return { remoteId: String(json?.id ?? ''), remoteUrl: String(json?.url ?? '') };
  },
};

const bluesky: Provider = {
  id: 'bluesky',
  label: 'Bluesky',
  credentialFields: ['identifier', 'app_password'],
  charLimit: 300,
  async publish({ body, link, creds }) {
    if (!creds.identifier || !creds.app_password) {
      throw new Error('Bluesky needs `identifier` and `app_password`');
    }
    const host = creds.service || 'https://bsky.social';
    const session = await postJson(`${host}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      body: JSON.stringify({
        identifier: creds.identifier,
        password: creds.app_password,
      }),
    });
    const record = await postJson(`${host}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: withLink(body, link),
          createdAt: new Date().toISOString(),
        },
      }),
    });
    const rkey = String(record?.uri ?? '').split('/').pop() ?? '';
    return {
      remoteId: String(record?.uri ?? ''),
      remoteUrl: rkey ? `https://bsky.app/profile/${creds.identifier}/post/${rkey}` : '',
    };
  },
};

const discord: Provider = {
  id: 'discord',
  label: 'Discord (webhook)',
  credentialFields: ['webhook_url'],
  charLimit: 2000,
  async publish({ body, link, creds }) {
    if (!creds.webhook_url) throw new Error('Discord needs `webhook_url`');
    await postJson(`${creds.webhook_url}?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ content: withLink(body, link) }),
    });
    return { remoteId: '', remoteUrl: '' };
  },
};

const telegram: Provider = {
  id: 'telegram',
  label: 'Telegram',
  credentialFields: ['bot_token', 'chat_id'],
  charLimit: 4096,
  async publish({ body, link, creds, accountConfig }) {
    const chatId = accountConfig.chat_id || creds.chat_id;
    if (!creds.bot_token || !chatId) throw new Error('Telegram needs `bot_token` and `chat_id`');
    const json = await postJson(`https://api.telegram.org/bot${creds.bot_token}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, text: withLink(body, link) }),
    });
    return { remoteId: String(json?.result?.message_id ?? ''), remoteUrl: '' };
  },
};

const webhook: Provider = {
  id: 'webhook',
  label: 'Generic webhook',
  credentialFields: ['url'],
  charLimit: 10_000,
  async publish({ body, link, media, creds, accountConfig }) {
    const url = accountConfig.url || creds.url;
    if (!url) throw new Error('Webhook needs a `url`');
    const json = await postJson(url, {
      method: 'POST',
      headers: creds.secret ? { 'x-helm-secret': creds.secret } : {},
      body: JSON.stringify({ body, link, media, posted_at: new Date().toISOString() }),
    });
    return { remoteId: String(json?.id ?? ''), remoteUrl: String(json?.url ?? '') };
  },
};

/**
 * For networks whose write APIs need a paid tier or a review process
 * (X/LinkedIn/Instagram). Helm still schedules and reminds; the post itself
 * is copied over by hand and marked done.
 */
const manual: Provider = {
  id: 'manual',
  label: 'Manual / copy-paste reminder',
  credentialFields: [],
  charLimit: 280,
  async publish() {
    return {
      remoteId: '',
      remoteUrl: '',
      note: 'Queued for manual posting - copy the text and mark it published.',
    };
  },
};

export const PROVIDERS: Record<string, Provider> = Object.fromEntries(
  [mastodon, bluesky, discord, telegram, webhook, manual].map((p) => [p.id, p])
);

export function getProvider(id: string): Provider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown social provider: ${id}`);
  return provider;
}
