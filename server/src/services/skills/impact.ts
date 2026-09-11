/**
 * Impact publisher (media partner) API.
 *
 * Impact issues every media partner an Account SID and Auth Token with no
 * approval step, which makes this the more reachable of the two APIs Helm can
 * talk to - and the more valuable one, because it carries two things Udemy's
 * affiliate API does not:
 *
 *   Catalogs  the advertiser's product feed. Where the advertiser publishes
 *             one, that is the whole course list with titles, prices and URLs,
 *             so the catalogue fills itself.
 *   Actions   your actual conversions and payouts. Clicks are a proxy for
 *             earnings; this is the earnings.
 *
 * Everything here parses defensively. This is an outside schema meeting Helm's,
 * the field names vary between programmes, and an unexpected key should cost
 * you a column rather than the whole sync.
 *
 * Note the Accept header: Impact answers XML by default, and asking for JSON is
 * not optional.
 */
import { config } from '../../config.js';

/**
 * Overridable so the integration can be exercised against a stub. Impact's own
 * API is the default and nothing in normal operation changes it.
 */
export const IMPACT_HOST = (process.env.HELM_IMPACT_HOST || 'https://api.impact.com').replace(
  /\/+$/,
  ''
);

export type ImpactCredentials = { accountSid: string; authToken: string };

export function authHeader(credentials: ImpactCredentials): string {
  const raw = `${credentials.accountSid}:${credentials.authToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

export function buildImpactUrl(
  accountSid: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): string {
  const clean = path.replace(/^\/+/, '');
  const url = new URL(`${IMPACT_HOST}/Mediapartners/${encodeURIComponent(accountSid)}/${clean}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Try several plausible key spellings before giving up on a field. */
function pick(row: any, keys: string[]): unknown {
  for (const key of keys) {
    if (row?.[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
}

function str(row: any, keys: string[], fallback = ''): string {
  const value = pick(row, keys);
  return value === undefined ? fallback : String(value);
}

/** Impact sends money as a decimal string ("84.99"). Helm stores integer cents. */
export function toCents(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Impact wraps collections in a named array alongside `@`-prefixed paging
 * metadata. The array key differs per endpoint, and a single-item response has
 * been known to arrive unwrapped, so both shapes are accepted.
 */
function collection(body: any, key: string): any[] {
  const value = body?.[key];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

/** The absolute URL of the next page, when Impact says there is one. */
export function nextPageUri(body: any): string | null {
  const raw = body?.['@nextpageuri'] ?? body?.nextpageuri ?? body?.NextPageUri;
  if (!raw || typeof raw !== 'string') return null;
  // It arrives as a path, not an absolute URL.
  return raw.startsWith('http') ? raw : `${IMPACT_HOST}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

// ------------------------------------------------------------------ types ---

export type ImpactCatalog = {
  id: string;
  name: string;
  campaignId: string;
  campaignName: string;
  itemCount: number;
};

export function parseCatalogs(body: any): ImpactCatalog[] {
  return collection(body, 'Catalogs')
    .map((row) => ({
      id: str(row, ['Id', 'CatalogId']),
      name: str(row, ['Name', 'CatalogName'], 'Untitled catalog'),
      campaignId: str(row, ['CampaignId']),
      campaignName: str(row, ['CampaignName', 'AdvertiserName']),
      itemCount: Number(pick(row, ['NumberOfItems', 'ItemCount', 'TotalItems']) ?? 0) || 0,
    }))
    .filter((c) => c.id);
}

export type ImpactCatalogItem = {
  externalId: string;
  name: string;
  url: string;
  imageUrl: string;
  description: string;
  priceCents: number;
  currency: string;
  category: string;
};

export function parseCatalogItems(body: any): ImpactCatalogItem[] {
  return collection(body, 'Items')
    .map((row) => ({
      externalId: str(row, ['CatalogItemId', 'Id', 'Sku']),
      name: str(row, ['Name', 'Title'], 'Untitled'),
      url: str(row, ['Url', 'ProductUrl', 'LinkUrl']),
      imageUrl: str(row, ['ImageUrl', 'Image']),
      description: str(row, ['Description', 'ShortDescription']),
      priceCents: toCents(pick(row, ['CurrentPrice', 'Price', 'OriginalPrice'])),
      currency: str(row, ['Currency', 'CurrencyCode'], 'USD').toUpperCase(),
      category: str(row, ['Category', 'CategoryName']),
    }))
    .filter((item) => item.url);
}

export type ImpactAction = {
  externalId: string;
  campaign: string;
  state: string;
  eventDate: string;
  saleCents: number;
  payoutCents: number;
  currency: string;
  subId: string;
};

/**
 * A conversion.
 *
 * `State` matters and is deliberately kept verbatim: an action sitting at
 * PENDING is not money, and one that has gone to REVERSED is money taken back.
 * Reporting the sum of everything as earnings would overstate them.
 */
export function parseActions(body: any): ImpactAction[] {
  return collection(body, 'Actions')
    .map((row) => ({
      externalId: str(row, ['Id', 'ActionId']),
      campaign: str(row, ['CampaignName', 'CampaignId']),
      state: str(row, ['State', 'Status'], 'UNKNOWN').toUpperCase(),
      eventDate: str(row, ['EventDate', 'CreationDate', 'ReferringDate']),
      saleCents: toCents(pick(row, ['Amount', 'SaleAmount', 'IntendedAmount'])),
      payoutCents: toCents(pick(row, ['Payout', 'PayoutAmount', 'IntendedPayout'])),
      currency: str(row, ['Currency', 'CurrencyCode'], 'USD').toUpperCase(),
      subId: str(row, ['SubId1', 'SubId', 'subId1', 'SharedId']),
    }))
    .filter((action) => action.externalId);
}

/**
 * Helm tags outbound Impact links with `helm-<resourceId>` in SubId1, and
 * Impact hands it back on the conversion. That tag is the whole reason earnings
 * can be attributed to a skill rather than landing in one undifferentiated
 * total.
 */
export const SUB_ID_PREFIX = 'helm-';

export function subIdForResource(resourceId: number): string {
  return `${SUB_ID_PREFIX}${resourceId}`;
}

export function resourceIdFromSubId(subId: string): number | null {
  const match = /^helm-(\d+)$/.exec((subId ?? '').trim());
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------------ fetch ---

export type ImpactOutcome<T> = { items: T[]; error?: string; pages?: number };

async function getJson(
  url: string,
  credentials: ImpactCredentials
): Promise<{ body: any; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        authorization: authHeader(credentials),
        // Impact answers XML unless asked otherwise.
        accept: 'application/json',
        'user-agent': config.userAgent,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { body: null, error: `Impact rejected the credentials (HTTP ${res.status})` };
    }
    if (!res.ok) return { body: null, error: `Impact returned HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (err: any) {
    return {
      body: null,
      error: err?.name === 'TimeoutError' ? 'Impact API timed out' : String(err?.message ?? err),
    };
  }
}

/**
 * Follow Impact's paging until the pages run out or `maxPages` is reached.
 *
 * The cap is not politeness alone: a large advertiser catalogue runs to tens of
 * thousands of items, and pulling all of it into a single-user SQLite file
 * would be a worse outcome than stopping early and saying so.
 */
async function getAllPages<T>(
  firstUrl: string,
  credentials: ImpactCredentials,
  parse: (body: any) => T[],
  maxPages: number
): Promise<ImpactOutcome<T>> {
  const items: T[] = [];
  let url: string | null = firstUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    const { body, error } = await getJson(url, credentials);
    if (error) return { items, error, pages };
    items.push(...parse(body));
    pages += 1;
    url = nextPageUri(body);
  }
  return { items, pages };
}

export async function listCatalogs(
  credentials: ImpactCredentials
): Promise<ImpactOutcome<ImpactCatalog>> {
  if (!credentials.accountSid || !credentials.authToken) {
    return { items: [], error: 'No Impact credentials configured' };
  }
  return getAllPages(
    buildImpactUrl(credentials.accountSid, 'Catalogs', { PageSize: 100 }),
    credentials,
    parseCatalogs,
    5
  );
}

export async function listCatalogItems(
  credentials: ImpactCredentials,
  catalogId: string,
  opts: { query?: string; maxPages?: number; pageSize?: number } = {}
): Promise<ImpactOutcome<ImpactCatalogItem>> {
  if (!credentials.accountSid || !credentials.authToken) {
    return { items: [], error: 'No Impact credentials configured' };
  }
  return getAllPages(
    buildImpactUrl(credentials.accountSid, `Catalogs/${encodeURIComponent(catalogId)}/Items`, {
      Query: opts.query,
      PageSize: Math.min(Math.max(opts.pageSize ?? 100, 1), 1000),
    }),
    credentials,
    parseCatalogItems,
    opts.maxPages ?? 5
  );
}

export async function listActions(
  credentials: ImpactCredentials,
  opts: { startDate: string; endDate: string; maxPages?: number }
): Promise<ImpactOutcome<ImpactAction>> {
  if (!credentials.accountSid || !credentials.authToken) {
    return { items: [], error: 'No Impact credentials configured' };
  }
  return getAllPages(
    buildImpactUrl(credentials.accountSid, 'Actions', {
      ActionDateStart: opts.startDate,
      ActionDateEnd: opts.endDate,
      PageSize: 100,
    }),
    credentials,
    parseActions,
    opts.maxPages ?? 20
  );
}
