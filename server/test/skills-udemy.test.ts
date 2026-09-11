import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AFFILIATE_DEFAULTS,
  buildAffiliateUrl,
  buildSearchUrl,
  normaliseUdemyUrl,
  parseContentDuration,
  parseUdemyCourse,
  safeOutboundUrl,
  udemyCourseSlug,
  type AffiliateConfig,
} from '../src/services/skills/udemy.js';

const cfg = (over: Partial<AffiliateConfig> = {}): AffiliateConfig => ({
  ...AFFILIATE_DEFAULTS,
  ...over,
});

const COURSE = 'https://www.udemy.com/course/the-complete-sql-bootcamp/';

test('only absolute http(s) URLs survive the outbound guard', () => {
  // The redirect endpoint sends a browser wherever this returns, so a
  // javascript: URL that reached the database must never come back out.
  assert.equal(safeOutboundUrl('javascript:alert(1)'), null);
  assert.equal(safeOutboundUrl('data:text/html,<script>'), null);
  assert.equal(safeOutboundUrl('/relative/path'), null);
  assert.equal(safeOutboundUrl(''), null);
  assert.ok(safeOutboundUrl('https://example.com/x'));
});

test('a Udemy URL is recognised, and a lookalike host is not', () => {
  assert.equal(normaliseUdemyUrl(COURSE), COURSE);
  assert.equal(normaliseUdemyUrl('https://udemy.com.evil.example/course/x/'), null);
  assert.equal(normaliseUdemyUrl('https://notudemy.com/course/x/'), null);
});

test('tracking params copied in with a link are stripped before it is stored', () => {
  const normalised = normaliseUdemyUrl(`${COURSE}?couponCode=X&utm_source=somebody-else`);
  assert.equal(normalised, COURSE);
});

test('the course slug is the external id', () => {
  assert.equal(udemyCourseSlug(COURSE), 'the-complete-sql-bootcamp');
  assert.equal(udemyCourseSlug('https://www.udemy.com/'), null);
});

test('with no network configured the link is the plain course URL', () => {
  const link = buildAffiliateUrl(COURSE, cfg({ network: 'none' }));
  assert.equal(link!.url, COURSE);
  assert.equal(link!.tracked, false);
});

test('a LinkSynergy deep link carries the publisher, merchant and destination', () => {
  const link = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'linksynergy', publisherId: 'PUB123', advertiserId: '39197' })
  );
  const url = new URL(link!.url);
  assert.equal(url.hostname, 'click.linksynergy.com');
  assert.equal(url.searchParams.get('id'), 'PUB123');
  assert.equal(url.searchParams.get('mid'), '39197');
  assert.equal(url.searchParams.get('murl'), COURSE);
  assert.equal(link!.tracked, true);
});

test('an Impact link appends the destination to the issued deep-link base', () => {
  const link = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'impact', linkBase: 'https://imp.example.net/c/1/2/3' })
  );
  assert.equal(new URL(link!.url).searchParams.get('u'), COURSE);
  assert.equal(link!.tracked, true);
});

test('an incomplete configuration falls back to the plain link rather than a broken one', () => {
  // A tracking link that 404s loses the click AND the reader; an untracked one
  // only loses the commission.
  for (const broken of [
    cfg({ network: 'linksynergy', publisherId: '' }),
    cfg({ network: 'impact', linkBase: '' }),
    cfg({ network: 'custom', template: 'no placeholder here' }),
  ]) {
    const link = buildAffiliateUrl(COURSE, broken);
    assert.equal(link!.url, COURSE);
    assert.equal(link!.tracked, false);
  }
});

test('a custom template fills either placeholder', () => {
  const encoded = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'custom', template: 'https://go.example.com/r?to={encoded_url}' })
  );
  assert.equal(new URL(encoded!.url).searchParams.get('to'), COURSE);

  const plain = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'custom', template: 'https://go.example.com/{url}' })
  );
  assert.ok(plain!.url.startsWith('https://go.example.com/'));
});

test('a custom template that produces a non-http URL is refused', () => {
  const link = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'custom', template: 'javascript:fetch({url})' })
  );
  assert.equal(link!.tracked, false);
  assert.equal(link!.url, COURSE);
});

test('extra params ride on the destination, inside the tracked link', () => {
  const link = buildAffiliateUrl(
    COURSE,
    cfg({ network: 'linksynergy', publisherId: 'P', advertiserId: 'M', extraParams: 'utm_source=helm' })
  );
  const inner = new URL(new URL(link!.url).searchParams.get('murl')!);
  assert.equal(inner.searchParams.get('utm_source'), 'helm');
});

test('a resource with no usable URL produces no link at all', () => {
  assert.equal(buildAffiliateUrl('not a url', cfg()), null);
});

test('course duration is read out of the free-text content info', () => {
  assert.equal(parseContentDuration('12.5 total hours'), 750);
  assert.equal(parseContentDuration('43 mins'), 43);
  assert.equal(parseContentDuration('2 total hours'), 120);
  assert.equal(parseContentDuration(undefined), 0);
  assert.equal(parseContentDuration('unparseable'), 0);
});

test('an API course maps onto a catalogue row, relative URL and all', () => {
  const course = parseUdemyCourse({
    id: 762616,
    title: 'The Complete SQL Bootcamp',
    url: '/course/the-complete-sql-bootcamp/',
    headline: 'Become an expert at SQL!',
    price_detail: { amount: 84.99, currency: 'usd' },
    avg_rating: 4.7,
    num_reviews: 12345,
    num_subscribers: 500000,
    content_info: '9 total hours',
    instructional_level: 'All Levels',
    image_240x135: 'https://img-c.udemycdn.com/course/240x135/762616.jpg',
    visible_instructors: [{ title: 'Jose Portilla' }],
  });

  assert.equal(course!.external_id, '762616');
  assert.equal(course!.url, COURSE);
  assert.equal(course!.price_cents, 8499, 'prices are integer cents, like the rest of Helm');
  assert.equal(course!.currency, 'USD');
  assert.equal(course!.duration_minutes, 540);
  assert.equal(course!.instructor, 'Jose Portilla');
  assert.equal(course!.rating, 4.7);
});

test('a course object missing most fields degrades instead of throwing', () => {
  const course = parseUdemyCourse({ id: 1, url: '/course/bare/' });
  assert.equal(course!.title, 'Untitled course');
  assert.equal(course!.price_cents, 0);
  assert.equal(course!.rating, 0);
  assert.equal(parseUdemyCourse(null), null);
  assert.equal(parseUdemyCourse({ id: 2, url: 'https://evil.example/course/x/' }), null);
});

test('the search URL asks only for the fields the catalogue stores', () => {
  const url = new URL(buildSearchUrl('sql', { pageSize: 5 }));
  assert.equal(url.searchParams.get('search'), 'sql');
  assert.equal(url.searchParams.get('page_size'), '5');
  assert.ok(url.searchParams.get('fields[course]')!.includes('avg_rating'));
  // Page size is clamped so a typo cannot ask Udemy for ten thousand courses.
  assert.equal(new URL(buildSearchUrl('sql', { pageSize: 9999 })).searchParams.get('page_size'), '50');
});
