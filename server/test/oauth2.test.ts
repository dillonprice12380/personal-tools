import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorizeUrl,
  getOAuth2Config,
  validateAppKeys,
} from '../src/services/social/oauth2.js';

const google = getOAuth2Config('google');
const linkedin = getOAuth2Config('linkedin');

test('accepts a real Google client id', () => {
  assert.equal(
    validateAppKeys(google, '123456789012-abc123def.apps.googleusercontent.com', 'GOCSPX-secret'),
    null
  );
});

test('rejects the values people paste by mistake', () => {
  // An API key, not an OAuth client id - the cause of Google's
  // "OAuth client was not found / invalid_client" dead end.
  const apiKey = validateAppKeys(google, 'AIzaSyD-EXAMPLE-KEY', 'GOCSPX-secret');
  assert.ok(apiKey);
  assert.match(apiKey!, /apps\.googleusercontent\.com/);

  // A bare project number.
  assert.ok(validateAppKeys(google, '123456789012', 'GOCSPX-secret'));
  // A client id from a different provider.
  assert.ok(validateAppKeys(google, '86abcdefghij', 'secret'));
});

test('catches a copy/paste slip that includes whitespace', () => {
  const err = validateAppKeys(
    google,
    '123456789012-abc .apps.googleusercontent.com',
    'GOCSPX-secret'
  );
  assert.match(err!, /space/);
});

test('requires both halves', () => {
  assert.match(validateAppKeys(google, '', 'secret')!, /required/);
  assert.match(
    validateAppKeys(google, '1-a.apps.googleusercontent.com', '')!,
    /required/
  );
});

test('providers without a known id shape accept anything non-empty', () => {
  // LinkedIn client ids have no publicly documented format to check against.
  assert.equal(validateAppKeys(linkedin, '86xyz123', 'secret'), null);
});

test('Google authorize URL asks for offline access, or refresh tokens never arrive', () => {
  const url = new URL(buildAuthorizeUrl(google, 'id.apps.googleusercontent.com', 'state123'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(
    url.searchParams.get('scope'),
    'https://www.googleapis.com/auth/webmasters.readonly'
  );
  assert.equal(url.searchParams.get('state'), 'state123');
});
