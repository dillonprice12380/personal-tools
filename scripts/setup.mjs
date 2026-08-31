/**
 * First-run setup: create .env with a strong HELM_SECRET.
 *
 * This exists so setup is one command on every platform. Generating a random
 * key inline differs across bash, PowerShell and cmd.exe, and PowerShell's
 * `>>` writes UTF-16, which would corrupt the file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (/^\s*HELM_SECRET\s*=\s*\S/m.test(existing)) {
  console.log('[helm] .env already has a HELM_SECRET - leaving it alone.');
  console.log('[helm] Next: npm run build   then   npm start');
  process.exit(0);
}

const secret = crypto.randomBytes(32).toString('hex');
const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
const block = `${prefix}# Encrypts stored API tokens. Back this up - without it they cannot be read.
HELM_SECRET=${secret}
`;

fs.writeFileSync(envPath, existing + block, { encoding: 'utf8' });
try {
  fs.chmodSync(envPath, 0o600); // no-op on Windows, meaningful elsewhere
} catch {
  /* not fatal */
}

console.log(`[helm] wrote ${envPath} with a new HELM_SECRET.`);
console.log('[helm] Back that file up - it decrypts your stored API tokens.');
console.log('[helm] Next: npm run build   then   npm start');
