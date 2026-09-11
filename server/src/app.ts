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
import { videoRouter } from './routes/video.js';
import { skillsRouter } from './routes/skills.js';
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
  api.use(videoRouter);
  api.use(skillsRouter);
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint')));

  // Rendered videos are served without a session, because Instagram and TikTok
  // fetch attached media themselves and cannot present a cookie. Each filename
  // carries 96 bits of randomness, so a render is reachable only by someone who
  // was given its URL, and a re-render always gets a new name.
  app.use(
    '/media/video',
    express.static(config.videoRendersDir, {
      index: false,
      dotfiles: 'deny',
      // Without this a missing or rejected path falls through to the SPA, and
      // an external fetcher asking for a deleted render gets 200 text/html
      // instead of a 404 it can act on.
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=300');
        // The directory only ever holds files Helm wrote, but a stray content
        // type should still never be sniffed into something executable.
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    })
  );

  // express.static reports a missing file as an ENOENT carrying the absolute
  // path it tried. That path is the operator's data directory, and this route
  // has no session in front of it, so the message is replaced.
  app.use(
    '/media/video',
    (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!err) return next();
      const status = err?.code === 'ENOENT' ? 404 : Number(err?.statusCode ?? err?.status) || 500;
      if (status >= 500) console.error('[helm]', err);
      res.status(status).json({ error: status === 404 ? 'Not found' : 'Forbidden' });
    }
  );

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
      // Express's own middleware reports failures by putting a status on the
      // error rather than by throwing an HttpError - a missing file under
      // express.static is a 404 that way, and would otherwise surface as a 500.
      const tagged = Number(err?.status ?? err?.statusCode);
      const status =
        err instanceof HttpError
          ? err.status
          : Number.isInteger(tagged) && tagged >= 400 && tagged <= 599
            ? tagged
            : 500;
      if (status >= 500) console.error('[helm]', err);
      res.status(status).json({
        error: err?.message ?? 'Internal error',
        ...(err?.details ? { details: err.details } : {}),
      });
    }
  );

  return app;
}
