import { config } from './config.js';
import { createApp } from './app.js';
import { startScheduler } from './services/scheduler.js';
import { userCount } from './lib/auth.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`[helm] API listening on http://localhost:${config.port}`);
  console.log(`[helm] database: ${config.dbPath}`);
  if (userCount() === 0) {
    console.log('[helm] no account yet - open the app to create one');
  }
  if (config.tickMs > 0) {
    startScheduler();
    console.log(`[helm] scheduler running every ${Math.round(config.tickMs / 1000)}s`);
  }
});
