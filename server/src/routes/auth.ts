import { Router } from 'express';
import {
  clearSessionCookie,
  createUser,
  login,
  logout,
  readToken,
  sessionUser,
  setSessionCookie,
  userCount,
} from '../lib/auth.js';
import { HttpError, requireFields, wrap } from '../lib/http.js';

export const authRouter = Router();

/** Tells the SPA whether to show the first-run setup screen or the login form. */
authRouter.get(
  '/status',
  wrap((req, res) => {
    const user = sessionUser(readToken(req));
    res.json({ needsSetup: userCount() === 0, user: user ?? null });
  })
);

/**
 * First-run account creation. Helm is single-user by design, so this closes
 * permanently once an account exists.
 */
authRouter.post(
  '/setup',
  wrap((req, res) => {
    if (userCount() > 0) throw new HttpError(409, 'Helm is already set up');
    requireFields(req.body ?? {}, ['email', 'password']);
    const { email, password, name } = req.body;
    createUser(email, password, name ?? '');
    const session = login(email, password);
    setSessionCookie(res, session.token);
    res.status(201).json({ user: session.user });
  })
);

authRouter.post(
  '/login',
  wrap((req, res) => {
    requireFields(req.body ?? {}, ['email', 'password']);
    const session = login(req.body.email, req.body.password);
    setSessionCookie(res, session.token);
    res.json({ user: session.user });
  })
);

authRouter.post(
  '/logout',
  wrap((req, res) => {
    const token = readToken(req);
    if (token) logout(token);
    clearSessionCookie(res);
    res.status(204).end();
  })
);
