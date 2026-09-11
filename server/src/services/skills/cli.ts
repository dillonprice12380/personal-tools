/**
 * O*NET import CLI.
 *
 *   npm run skills:import -- --dir ./db_30_0_text
 *   npm run skills:import -- --dir ./db_30_0_text --only 15-1252.00,13-1161.00
 *   npm run skills:import -- --dir ./db_30_0_text --no-technology
 *
 * Download the tab-delimited bundle from https://www.onetcenter.org/database.html
 * and unzip it; point --dir at the unzipped folder. O*NET data is published
 * under CC BY 4.0 - see docs/SKILLS.md for the attribution you owe if you show
 * it to anyone else.
 */
import { importOnet } from './onet.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] ?? null : null;
}

const dir = arg('dir');
if (!dir) {
  console.error('Usage: npm run skills:import -- --dir <unzipped O*NET text folder>');
  process.exit(1);
}

const only = arg('only');
const report = importOnet({
  dir,
  onlyCodes: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  includeTechnology: !process.argv.includes('--no-technology'),
});

console.log(`[helm] read: ${report.files.join(', ') || 'nothing'}`);
if (report.skipped.length) console.log(`[helm] not present: ${report.skipped.join(', ')}`);
console.log(
  `[helm] imported ${report.occupations} occupations, ${report.skills} skills, ` +
    `${report.requirements} requirement rows`
);
