/**
 * Reference-link sanity checks.
 *
 * Any http(s) URL is a legitimate reference for a skill - a course, a book, a
 * docs page - so nothing here refuses a save. What it does is notice the cases
 * where a link is probably not what was intended, because the damage from a
 * silently wrong affiliate link is delayed and invisible: it saves fine, sits
 * in the analyser for weeks, and earns nothing.
 *
 * The checks are ordered by how much they actually tell you. "I don't
 * recognise this host" is weak - most of the web is not a course platform. "This
 * is one character off a host I do recognise" is strong.
 */

export type LinkWarningCode =
  | 'possible_typo'
  | 'impersonating_host'
  | 'suspicious_host'
  | 'not_a_course_page'
  | 'unknown_platform';

export type LinkWarning = {
  code: LinkWarningCode;
  message: string;
  /** 'warning' is probably wrong; 'info' is worth a glance. */
  severity: 'warning' | 'info';
};

export type LinkClassification = {
  /** Display name of the recognised platform, or null. */
  platform: string | null;
  host: string;
  warnings: LinkWarning[];
};

/**
 * Platforms a learning reference plausibly points at. Not a gate - it exists so
 * a near-miss can be spotted, which needs something to be near.
 */
const PLATFORMS: Array<{ host: string; name: string }> = [
  { host: 'udemy.com', name: 'Udemy' },
  { host: 'coursera.org', name: 'Coursera' },
  { host: 'edx.org', name: 'edX' },
  { host: 'pluralsight.com', name: 'Pluralsight' },
  { host: 'linkedin.com', name: 'LinkedIn Learning' },
  { host: 'skillshare.com', name: 'Skillshare' },
  { host: 'datacamp.com', name: 'DataCamp' },
  { host: 'codecademy.com', name: 'Codecademy' },
  { host: 'frontendmasters.com', name: 'Frontend Masters' },
  { host: 'egghead.io', name: 'egghead' },
  { host: 'masterclass.com', name: 'MasterClass' },
  { host: 'futurelearn.com', name: 'FutureLearn' },
  { host: 'khanacademy.org', name: 'Khan Academy' },
  { host: 'freecodecamp.org', name: 'freeCodeCamp' },
  { host: 'oreilly.com', name: "O'Reilly" },
  { host: 'manning.com', name: 'Manning' },
  { host: 'leanpub.com', name: 'Leanpub' },
  { host: 'packtpub.com', name: 'Packt' },
  { host: 'teachable.com', name: 'Teachable' },
  { host: 'thinkific.com', name: 'Thinkific' },
  { host: 'gumroad.com', name: 'Gumroad' },
  { host: 'youtube.com', name: 'YouTube' },
];

/** Levenshtein distance, capped - only small distances are interesting here. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

const stripWww = (host: string) => host.replace(/^www\./, '');

function matchPlatform(host: string) {
  const bare = stripWww(host);
  return PLATFORMS.find((p) => bare === p.host || bare.endsWith(`.${p.host}`)) ?? null;
}

/**
 * Look over a reference URL before it is saved.
 *
 * Returns warnings, never a refusal: the caller saves the link either way and
 * shows what came back.
 */
export function classifyReferenceUrl(raw: string): LinkClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { platform: null, host: '', warnings: [] };
  }

  const host = url.hostname.toLowerCase();
  const bare = stripWww(host);
  const warnings: LinkWarning[] = [];
  const platform = matchPlatform(host);

  // Shapes that are wrong regardless of platform. Any of these ends the check:
  // telling someone their IP address "is not a platform Helm recognises" on top
  // of it being unreachable is noise stacked on the real problem.
  if (url.username || url.password) {
    warnings.push({
      code: 'suspicious_host',
      severity: 'warning',
      message:
        'This URL carries a username before the host, which is a common way to disguise where a link actually goes.',
    });
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || !host.includes('.')) {
    warnings.push({
      code: 'suspicious_host',
      severity: 'warning',
      message: `"${host}" is not a public web address, so nobody else will be able to open this link.`,
    });
  } else if (host.includes('xn--')) {
    warnings.push({
      code: 'suspicious_host',
      severity: 'warning',
      message:
        'This host uses punycode, which can make one domain look like another. Check it is the site you meant.',
    });
  }
  if (warnings.length) return { platform: platform?.name ?? null, host, warnings };

  if (platform) {
    // A recognised platform, but possibly not a course page on it.
    if (platform.host === 'udemy.com' && !/^\/course\//.test(url.pathname)) {
      warnings.push({
        code: 'not_a_course_page',
        severity: 'info',
        message:
          'This is a Udemy link but not a /course/ page, so it may not be something anyone can enrol in.',
      });
    }
    return { platform: platform.name, host, warnings };
  }

  // A known platform's name inside a host that is not that platform: the shape
  // of both a typo'd subdomain and a deliberate lookalike.
  const impersonated = PLATFORMS.find(
    (p) => bare.includes(p.host) && !bare.endsWith(p.host)
  );
  if (impersonated) {
    warnings.push({
      code: 'impersonating_host',
      severity: 'warning',
      message: `"${host}" contains "${impersonated.host}" but is not ${impersonated.name}. Check the address carefully.`,
    });
    return { platform: null, host, warnings };
  }

  // One or two characters away from a platform - almost always a typo, and the
  // check most likely to catch a real mistake.
  const nearest = PLATFORMS.map((p) => ({ p, d: editDistance(bare, p.host) })).sort(
    (a, b) => a.d - b.d
  )[0];
  if (nearest && nearest.d > 0 && nearest.d <= 2) {
    warnings.push({
      code: 'possible_typo',
      severity: 'warning',
      message: `"${host}" is very close to ${nearest.p.host}. Did you mean ${nearest.p.name}?`,
    });
    return { platform: null, host, warnings };
  }

  warnings.push({
    code: 'unknown_platform',
    severity: 'info',
    message: `Saved. "${host}" is not a learning platform Helm recognises — fine for a book or a docs page, worth a second look if you meant a course.`,
  });
  return { platform: null, host, warnings };
}
