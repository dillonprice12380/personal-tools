import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { requireAuth } from './lib/auth.js';
import { HttpError } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { oauthRouter } from './routes/oauth.js';
import { tasksRouter } from './routes/tasks.js';
import { socialRouter } from './routes/social.js';
import { seoRouter } from './routes/seo.js';
import { budgetRouter } from './routes/budget.js';
import { businessRouter } from './routes/business.js';
import { dashboardRouter } from './routes/dashboard.js';

export function createApp() {
  const app = express();
  // A tunnel (tailscaled, cloudflared) connects from loopback and forwards
  // X-Forwarded-* headers; trusting only loopback keeps those headers from
  // being spoofable by a remote client.
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'helm' }));
  app.use('/api/auth', authRouter);

  // Everything past this point requires a session.
  const api = express.Router();
  api.use(requireAuth);
  api.use('/settings', settingsRouter);
  api.use('/oauth', oauthRouter);
  api.use('/dashboard', dashboardRouter);
  api.use(tasksRouter);
  api.use(socialRouter);
  api.use(seoRouter);
  api.use(budgetRouter);
  api.use(businessRouter);
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint')));

  // In production the API also serves the built SPA, so Helm runs on one port.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get('*', (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[helm]', err);
      res.status(status).json({
        error: err?.message ?? 'Internal error',
        ...(err?.details ? { details: err.details } : {}),
      });
    }
  );

  return app;
}
