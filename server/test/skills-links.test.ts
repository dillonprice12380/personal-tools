import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReferenceUrl, editDistance } from '../src/services/skills/links.js';

const codes = (url: string) => classifyReferenceUrl(url).warnings.map((w) => w.code);

test('a recognised course page saves with no warning at all', () => {
  const result = classifyReferenceUrl('https://www.udemy.com/course/the-complete-sql-bootcamp/');
  assert.equal(result.platform, 'Udemy');
  assert.deepEqual(result.warnings, []);
});

test('other known platforms are recognised too', () => {
  assert.equal(classifyReferenceUrl('https://www.coursera.org/learn/machine-learning').platform, 'Coursera');
  assert.equal(classifyReferenceUrl('https://frontendmasters.com/courses/react/').platform, 'Frontend Masters');
  assert.equal(classifyReferenceUrl('https://sub.udemy.com/anything').platform, 'Udemy');
});

test('a typo one character off a platform is the warning that matters most', () => {
  // The case this whole check exists for: it saves fine, looks right, earns
  // nothing.
  assert.deepEqual(codes('https://www.udmey.com/course/x/'), ['possible_typo']);
  assert.deepEqual(codes('https://www.coursera.or/learn/x'), ['possible_typo']);
  assert.match(
    classifyReferenceUrl('https://udemi.com/course/x/').warnings[0].message,
    /Did you mean Udemy\?/
  );
});

test('a host that merely contains a platform name is flagged, not trusted', () => {
  assert.deepEqual(codes('https://udemy.com.login-verify.example/course/x/'), ['impersonating_host']);
  assert.equal(classifyReferenceUrl('https://udemy.com.evil.example/x').platform, null);
});

test('hosts nobody else can reach are called out', () => {
  assert.deepEqual(codes('http://localhost:3000/course'), ['suspicious_host']);
  assert.deepEqual(codes('http://192.168.1.50/course'), ['suspicious_host']);
});

test('a disguised destination is flagged ahead of anything else', () => {
  const result = classifyReferenceUrl('https://www.udemy.com@evil.example/course/x/');
  assert.equal(result.warnings[0].code, 'suspicious_host');
  assert.equal(result.warnings[0].severity, 'warning');
});

test('a homograph domain is flagged once the URL parser normalises it', () => {
  // "udеmy.com" with a Cyrillic e. The URL parser turns it into punycode,
  // which is what makes it detectable - it renders as "udemy.com" to a reader.
  const result = classifyReferenceUrl('https://udеmy.com/course/x/');
  assert.equal(result.host, 'xn--udmy-w4d.com');
  assert.deepEqual(result.warnings.map((w) => w.code), ['suspicious_host']);
});

test('a Udemy link that is not a course page is a note, not an alarm', () => {
  const result = classifyReferenceUrl('https://www.udemy.com/user/jose-portilla/');
  assert.deepEqual(codes('https://www.udemy.com/user/jose-portilla/'), ['not_a_course_page']);
  assert.equal(result.warnings[0].severity, 'info');
  assert.equal(result.platform, 'Udemy', 'it is still Udemy');
});

test('an ordinary unrecognised site is info-level, because a book is a fair reference', () => {
  const result = classifyReferenceUrl('https://example.com/books/on-writing-well');
  assert.deepEqual(result.warnings.map((w) => w.code), ['unknown_platform']);
  assert.equal(result.warnings[0].severity, 'info');
});

test('nothing throws on input that is not a URL', () => {
  assert.deepEqual(classifyReferenceUrl('not a url').warnings, []);
  assert.deepEqual(classifyReferenceUrl('').warnings, []);
});

test('edit distance is cheap and bails on lengths that cannot be close', () => {
  assert.equal(editDistance('udemy.com', 'udemy.com'), 0);
  assert.equal(editDistance('udmey.com', 'udemy.com'), 2);
  assert.equal(editDistance('a', 'abcdefghij'), 99);
});
