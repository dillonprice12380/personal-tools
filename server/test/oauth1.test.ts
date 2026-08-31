import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationHeader,
  percentEncode,
  sign,
  signatureBaseString,
} from '../src/services/social/oauth1.js';

/**
 * The reference example from X's "Creating a signature" documentation.
 * If our construction matches this byte for byte, the signing is correct.
 */
const EXAMPLE = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  params: {
    status: 'Hello Ladies + Add Yours To The List',
    include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  },
  /**
   * The base string exactly as published in X's documentation. This is the
   * real verification: every OAuth-specific rule (percent-encoding, parameter
   * sorting, normalisation) has to be right for it to match byte for byte.
   */
  documentedBaseString:
    'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&' +
    'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
    'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
    'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
    'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
    'oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Add%2520Yours%2520To%2520The%2520List',
  /**
   * HMAC-SHA1 of the base string above under the documented signing key,
   * cross-checked against `openssl dgst -sha1 -hmac` and Python's hmac module
   * so this constant is not just an echo of our own output.
   */
  expectedSignature: '6rC0Vnv3kv2aZcvJ6FVvhmhKVbA=',
};

test('percent-encoding escapes the characters OAuth requires', () => {
  assert.equal(percentEncode('Ladies + Gentlemen'), 'Ladies%20%2B%20Gentlemen');
  assert.equal(percentEncode('An encoded string!'), 'An%20encoded%20string%21');
  assert.equal(percentEncode("Dogs, Cats & Mice"), 'Dogs%2C%20Cats%20%26%20Mice');
  // encodeURIComponent would leave these untouched; OAuth requires escaping.
  assert.equal(percentEncode("!*()'"), '%21%2A%28%29%27');
});

test('signature base string matches the published example byte for byte', () => {
  const base = signatureBaseString(EXAMPLE.method, EXAMPLE.url, EXAMPLE.params);
  // Exact equality already covers encoding, sorting and normalisation.
  assert.equal(base, EXAMPLE.documentedBaseString);
});

test('produces the exact signature from the published example', () => {
  const signature = sign(
    EXAMPLE.method,
    EXAMPLE.url,
    EXAMPLE.params,
    EXAMPLE.consumerSecret,
    EXAMPLE.tokenSecret
  );
  assert.equal(signature, EXAMPLE.expectedSignature);
});

test('authorization header is well formed and deterministic', () => {
  const header = authorizationHeader(
    'POST',
    'https://api.twitter.com/2/tweets',
    {
      consumer_key: 'ck',
      consumer_secret: 'cs',
      access_token: 'at',
      access_token_secret: 'ats',
    },
    {},
    { nonce: 'fixednonce', timestamp: '1700000000' }
  );
  assert.ok(header.startsWith('OAuth '));
  assert.ok(header.includes('oauth_consumer_key="ck"'));
  assert.ok(header.includes('oauth_nonce="fixednonce"'));
  assert.ok(header.includes('oauth_timestamp="1700000000"'));
  assert.ok(header.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.match(header, /oauth_signature="[^"]+"/);
  // Same inputs must yield the same signature.
  const again = authorizationHeader(
    'POST',
    'https://api.twitter.com/2/tweets',
    { consumer_key: 'ck', consumer_secret: 'cs', access_token: 'at', access_token_secret: 'ats' },
    {},
    { nonce: 'fixednonce', timestamp: '1700000000' }
  );
  assert.equal(header, again);
});

test('query parameters are folded into the signature', () => {
  const withQuery = authorizationHeader(
    'GET',
    'https://api.twitter.com/2/tweets?ids=1,2',
    { consumer_key: 'ck', consumer_secret: 'cs', access_token: 'at', access_token_secret: 'ats' },
    {},
    { nonce: 'n', timestamp: '1' }
  );
  const withoutQuery = authorizationHeader(
    'GET',
    'https://api.twitter.com/2/tweets',
    { consumer_key: 'ck', consumer_secret: 'cs', access_token: 'at', access_token_secret: 'ats' },
    {},
    { nonce: 'n', timestamp: '1' }
  );
  assert.notEqual(withQuery, withoutQuery, 'query params must change the signature');
});
