import { config } from './config.js';
import { createApp } from './app.js';
import { startScheduler } from './services/scheduler.js';
import { userCount } from './lib/auth.js';
import { resetInterruptedRenders } from './services/video/projects.js';

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(`[helm] listening on http://${config.host}:${config.port}`);
  console.log(`[helm] database: ${config.dbPath}`);
  if (config.host === '127.0.0.1') {
    console.log('[helm] loopback only - use a tunnel for remote access (see docs/REMOTE-ACCESS.md)');
  } else {
    console.log(`[helm] reachable on the network at ${config.host} - make sure that is intended`);
  }
  if (!config.secureCookies) {
    console.log('[helm] session cookies are not marked Secure (set HELM_SECURE_COOKIES=1 behind HTTPS)');
  }
  if (userCount() === 0) {
    console.log('[helm] no account yet - open the app to create one');
  }
  // A render lives in a child process, so anything in flight died with the
  // last process; leaving the row saying "rendering" would hang the UI for ever.
  const interrupted = resetInterruptedRenders();
  if (interrupted > 0) {
    console.log(`[helm] ${interrupted} video render(s) were interrupted by a restart and need starting again`);
  }
  if (config.tickMs > 0) {
    startScheduler();
    console.log(`[helm] scheduler running every ${Math.round(config.tickMs / 1000)}s`);
  }
});
