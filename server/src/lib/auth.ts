import type { NextFunction, Request, Response } from 'express';
import { all, get, run } from '../db.js';
import { hashPassword, randomToken, verifyPassword } from './crypto.js';
import { HttpError } from './http.js';

const COOKIE = 'helm_session';
const SESSION_DAYS = 30;

export type User = { id: number; email: string; name: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function userCount(): number {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return row?.n ?? 0;
}

export function createUser(email: string, password: string, name: string): User {
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const info = run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', [
    email.toLowerCase().trim(),
    name,
    hashPassword(password),
  ]);
  return { id: Number(info.lastInsertRowid), email, name };
}

export function login(email: string, password: string): { user: User; token: string } {
  const row = get<{ id: number; email: string; name: string; password_hash: string }>(
    'SELECT id, email, name, password_hash FROM users WHERE email = ?',
    [email.toLowerCase().trim()]
  );
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, 'Invalid email or password');
  }
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [
    token,
    row.id,
    expires,
  ]);
  return { user: { id: row.id, email: row.email, name: row.name }, token };
}

export function logout(token: string) {
  run('DELETE FROM sessions WHERE token = ?', [token]);
}

export function sessionUser(token: string | undefined): User | undefined {
  if (!token) return undefined;
  return get<User>(
    `SELECT u.id, u.email, u.name FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token]
  );
}

export function purgeExpiredSessions() {
  run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 864e5,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE);
}

export function readToken(req: Request): string | undefined {
  return req.cookies?.[COOKIE];
}

/** Gate every route behind a valid session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = sessionUser(readToken(req));
  if (!user) return next(new HttpError(401, 'Authentication required'));
  req.user = user;
  next();
}

export function listUsers(): User[] {
  return all<User>('SELECT id, email, name FROM users ORDER BY id');
}
