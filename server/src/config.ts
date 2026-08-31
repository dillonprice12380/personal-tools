import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Load a .env file if one is present, before anything reads process.env.
 * Real environment variables always win over the file - that is what
 * process.loadEnvFile already does for us.
 *
 * Candidates cover both the working directory and the location of this module,
 * because a service manager (systemd, launchd) often starts the process from
 * some unrelated directory. Missing that file is a quiet failure - Helm would
 * fall back to a generated dev secret and later be unable to decrypt stored
 * API tokens - so it is worth looking in more than one place.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
  path.resolve(moduleDir, '../.env'),
  path.resolve(moduleDir, '../../.env'),
];

for (const file of [...new Set(envCandidates)]) {
  try {
    if (!fs.existsSync(file)) continue;
    process.loadEnvFile(file);
    break;
  } catch {
    // A malformed .env must not stop the server from booting.
    console.warn(`[helm] could not read ${file} - ignoring it`);
  }
}

const root = process.env.HELM_DATA_DIR
  ? path.resolve(process.env.HELM_DATA_DIR)
  : path.resolve(process.cwd(), '../data');

fs.mkdirSync(root, { recursive: true });

export const config = {
  dataDir: root,
  dbPath: process.env.HELM_DB_PATH || path.join(root, 'helm.db'),
  port: Number(process.env.PORT || 4000),
  /**
   * Bind address. Defaults to loopback so Helm is not exposed to the local
   * network by accident - a tunnel (Tailscale, cloudflared) connects to it
   * from localhost. Set HELM_HOST=0.0.0.0 to serve the LAN directly.
   */
  host: process.env.HELM_HOST || '127.0.0.1',
  /** Master key for the credential vault and session signing. */
  secret: process.env.HELM_SECRET || '',
  isProd: process.env.NODE_ENV === 'production',
  /**
   * Mark session cookies `Secure`. Off by default because a Secure cookie is
   * dropped by the browser on a plain-HTTP origin that is not localhost - so
   * over a LAN IP you would log in and be bounced straight back to the login
   * screen on the next page load. (Browsers treat localhost as trustworthy,
   * so it survives there.) Turn this on when Helm is reached over HTTPS
   * through a tunnel, which is the setup described in docs/REMOTE-ACCESS.md.
   */
  secureCookies: process.env.HELM_SECURE_COOKIES === '1',
  /** Where the built SPA lives when serving in production. */
  webDist: path.resolve(process.cwd(), '../web/dist'),
  /** Scheduler tick, in ms. Set to 0 to disable background work. */
  tickMs: Number(process.env.HELM_TICK_MS || 60_000),
  userAgent:
    process.env.HELM_USER_AGENT ||
    'HelmBot/1.0 (+self-hosted SEO auditor; single-user)',
};

if (!config.secret) {
  // A missing secret must not silently produce an unrecoverable vault: the
  // credential ciphertext would be undecryptable after the next restart.
  if (config.isProd) {
    throw new Error(
      'HELM_SECRET is required in production. Generate one with: openssl rand -hex 32'
    );
  }
  const devKeyFile = path.join(root, '.dev-secret');
  if (!fs.existsSync(devKeyFile)) {
    fs.writeFileSync(devKeyFile, crypto.randomBytes(32).toString('hex'), {
      mode: 0o600,
    });
  }
  config.secret = fs.readFileSync(devKeyFile, 'utf8').trim();
}
