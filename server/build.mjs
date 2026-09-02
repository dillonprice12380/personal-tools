/**
 * Server bundle. Kept as a script rather than a long esbuild CLI string so the
 * quoting survives cmd.exe, PowerShell and POSIX shells alike.
 */
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Native modules are loaded at runtime, not bundled. ffmpeg-static and
  // ffprobe-static resolve a binary path relative to their own package, which
  // only survives if they stay outside the bundle too.
  external: ['better-sqlite3', '@resvg/resvg-js', 'ffmpeg-static', 'ffprobe-static'],
  // Some bundled dependencies still expect CommonJS `require`. The import is
  // aliased because a bundled module may import `createRequire` itself, and two
  // declarations of the same name in one ESM file is a syntax error.
  banner: {
    js: "import { createRequire as __helmCreateRequire } from 'module';\nconst require = __helmCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/server.js' });

// The render worker is a separate entry because it runs as its own process.
await build({ ...shared, entryPoints: ['src/services/video/worker.ts'], outfile: 'dist/video-worker.js' });
