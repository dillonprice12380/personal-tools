import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImpactUrl,
  authHeader,
  nextPageUri,
  parseActions,
  parseCatalogItems,
  parseCatalogs,
  resourceIdFromSubId,
  subIdForResource,
  toCents,
} from '../src/services/skills/impact.js';

test('requests are addressed under the account and authenticated with Basic', () => {
  const url = buildImpactUrl('IRabc123', 'Catalogs', { PageSize: 100, Query: '' });
  assert.equal(url, 'https://api.impact.com/Mediapartners/IRabc123/Catalogs?PageSize=100');
  assert.equal(
    authHeader({ accountSid: 'sid', authToken: 'token' }),
    `Basic ${Buffer.from('sid:token').toString('base64')}`
  );
});

test('empty params are dropped rather than sent as blanks', () => {
  const url = new URL(buildImpactUrl('SID', 'Actions', { ActionDateStart: '2026-01-01', Foo: undefined }));
  assert.equal(url.searchParams.get('ActionDateStart'), '2026-01-01');
  assert.equal(url.searchParams.has('Foo'), false);
});

test('money arrives as a decimal string and is stored as integer cents', () => {
  assert.equal(toCents('84.99'), 8499);
  assert.equal(toCents(12), 1200);
  assert.equal(toCents('$1,234.50'), 123450);
  assert.equal(toCents(''), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(toCents('not money'), 0);
});

test('catalogues parse out of the wrapped collection', () => {
  const catalogs = parseCatalogs({
    '@page': '1',
    Catalogs: [
      { Id: '1234', Name: 'Udemy Courses', CampaignId: '39854', CampaignName: 'Udemy', NumberOfItems: '21000' },
    ],
  });
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0], {
    id: '1234',
    name: 'Udemy Courses',
    campaignId: '39854',
    campaignName: 'Udemy',
    itemCount: 21000,
  });
});

test('a single-item collection that arrives unwrapped is still read', () => {
  // Impact has been known to send one result as an object rather than a
  // one-element array.
  const catalogs = parseCatalogs({ Catalogs: { Id: '9', Name: 'Solo' } });
  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].id, '9');
});

test('catalogue items parse, trying the alternate field spellings', () => {
  const items = parseCatalogItems({
    Items: [
      {
        CatalogItemId: 'abc',
        Name: 'The Complete SQL Bootcamp',
        Url: 'https://www.udemy.com/course/the-complete-sql-bootcamp/',
        CurrentPrice: '84.99',
        Currency: 'usd',
        ImageUrl: 'https://img.example/1.jpg',
        Description: 'Become an expert at SQL',
      },
      // Same shape, different names for the same things.
      { Id: 'def', Title: 'Another', ProductUrl: 'https://www.udemy.com/course/another/', Price: '19.99' },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].priceCents, 8499);
  assert.equal(items[0].currency, 'USD');
  assert.equal(items[1].name, 'Another');
  assert.equal(items[1].priceCents, 1999);
});

test('an item with no URL is dropped, because it cannot become a link', () => {
  const items = parseCatalogItems({ Items: [{ Id: 'x', Name: 'No link here' }] });
  assert.deepEqual(items, []);
});

test('conversions parse, keeping the state verbatim', () => {
  const actions = parseActions({
    Actions: [
      { Id: 'A1', CampaignName: 'Udemy', State: 'approved', EventDate: '2026-08-01', Amount: '84.99', Payout: '12.75', Currency: 'USD', SubId1: 'helm-42' },
      { Id: 'A2', CampaignName: 'Udemy', State: 'PENDING', EventDate: '2026-08-02', Amount: '19.99', Payout: '3.00' },
    ],
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].state, 'APPROVED');
  assert.equal(actions[0].payoutCents, 1275);
  assert.equal(actions[0].subId, 'helm-42');
  assert.equal(actions[1].state, 'PENDING', 'pending is not folded into approved');
  assert.equal(actions[1].subId, '', 'an untagged conversion is kept, just unattributed');
});

test('an action with no id is dropped, since it cannot be de-duplicated on re-sync', () => {
  assert.deepEqual(parseActions({ Actions: [{ State: 'APPROVED', Payout: '5.00' }] }), []);
});

test('the sub id round-trips a resource id, and rejects anything else', () => {
  assert.equal(subIdForResource(42), 'helm-42');
  assert.equal(resourceIdFromSubId('helm-42'), 42);
  assert.equal(resourceIdFromSubId(' helm-42 '), 42);
  assert.equal(resourceIdFromSubId('someone-elses-subid'), null);
  assert.equal(resourceIdFromSubId('helm-'), null);
  assert.equal(resourceIdFromSubId(''), null);
});

test('paging follows the next-page pointer, absolute or relative', () => {
  assert.equal(
    nextPageUri({ '@nextpageuri': '/Mediapartners/SID/Actions?Page=2' }),
    'https://api.impact.com/Mediapartners/SID/Actions?Page=2'
  );
  assert.equal(nextPageUri({ '@nextpageuri': 'https://api.impact.com/x?Page=2' }), 'https://api.impact.com/x?Page=2');
  assert.equal(nextPageUri({}), null, 'no pointer means the last page');
});

test('a response missing its collection yields nothing rather than throwing', () => {
  assert.deepEqual(parseCatalogs({}), []);
  assert.deepEqual(parseCatalogItems(null), []);
  assert.deepEqual(parseActions({ Actions: null }), []);
});
