import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HELM_SECRET ??= 'test-secret-for-unit-tests';
process.env.HELM_DATA_DIR ??= '/tmp/helm-test-data';

const { encrypt, decrypt, encryptJson, decryptJson, hashPassword, verifyPassword } = await import(
  '../src/lib/crypto.js'
);

test('round-trips a secret', () => {
  const plain = 'super-secret-token';
  assert.equal(decrypt(encrypt(plain)), plain);
});

test('ciphertext differs each time (random IV)', () => {
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('tampering is rejected by the auth tag', () => {
  const payload = encrypt('token');
  const [iv, tag, data] = payload.split('.');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decrypt([iv, tag, flipped.toString('base64')].join('.')));
});

test('malformed ciphertext throws rather than returning junk', () => {
  assert.throws(() => decrypt('not-a-real-payload'));
});

test('JSON credentials round-trip', () => {
  const creds = { api_key: 'abc123', instance: 'https://example.social' };
  assert.deepEqual(decryptJson(encryptJson(creds)), creds);
});

test('password hashing verifies correctly and rejects wrong passwords', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.ok(verifyPassword('correct horse battery staple', stored));
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('the same password hashes differently each time (per-password salt)', () => {
  assert.notEqual(hashPassword('pw12345678'), hashPassword('pw12345678'));
});
