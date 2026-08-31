import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = process.env.HELM_DATA_DIR
  ? path.resolve(process.env.HELM_DATA_DIR)
  : path.resolve(process.cwd(), '../data');

fs.mkdirSync(root, { recursive: true });

export const config = {
  dataDir: root,
  dbPath: process.env.HELM_DB_PATH || path.join(root, 'helm.db'),
  port: Number(process.env.PORT || 4000),
  /** Master key for the credential vault and session signing. */
  secret: process.env.HELM_SECRET || '',
  isProd: process.env.NODE_ENV === 'production',
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
