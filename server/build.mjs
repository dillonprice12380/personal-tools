/**
 * Server bundle. Kept as a script rather than a long esbuild CLI string so the
 * quoting survives cmd.exe, PowerShell and POSIX shells alike.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/server.js',
  // The native module is loaded at runtime, not bundled.
  external: ['better-sqlite3'],
  // Some bundled dependencies still expect CommonJS `require`.
  banner: {
    js: "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
