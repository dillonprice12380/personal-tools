import crypto from 'node:crypto';

/**
 * OAuth 1.0a request signing (HMAC-SHA1), as used by the X/Twitter API.
 *
 * Implemented directly rather than pulled in as a dependency: it is about
 * forty lines, and X is the only caller. The construction follows RFC 5849
 * §3.4 and is verified against the signature example published in X's own
 * "Creating a signature" documentation (see test/oauth1.test.ts).
 */
export type OAuth1Credentials = {
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_token_secret: string;
};

/**
 * RFC 3986 percent-encoding. encodeURIComponent leaves ! * ( ) ' alone, and
 * OAuth requires them escaped - miss this and signatures fail intermittently,
 * only for posts containing those characters.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*()']/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** The normalised parameter string: sorted by encoded key, then value. */
function normaliseParams(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>
): string {
  return [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(normaliseParams(params)),
  ].join('&');
}

export function sign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto
    .createHmac('sha1', signingKey)
    .update(signatureBaseString(method, url, params))
    .digest('base64');
}

/**
 * Build an OAuth 1.0a Authorization header.
 *
 * `bodyParams` must contain form-encoded body fields only. A JSON body is not
 * part of the signature base string, which is why X API v2 (JSON) signs just
 * the OAuth parameters plus any query string.
 */
export function authorizationHeader(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  bodyParams: Record<string, string> = {},
  overrides: { nonce?: string; timestamp?: string } = {}
): string {
  const parsed = new URL(url);
  const queryParams: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    queryParams[k] = v;
  });
  // The base string uses the URL without its query component.
  const baseUrl = `${parsed.origin}${parsed.pathname}`;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumer_key,
    oauth_nonce: overrides.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: overrides.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.access_token,
    oauth_version: '1.0',
  };

  const signature = sign(
    method,
    baseUrl,
    { ...queryParams, ...bodyParams, ...oauthParams },
    creds.consumer_secret,
    creds.access_token_secret
  );

  return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ')}`;
}
