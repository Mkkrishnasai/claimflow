import { timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient, Role } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock } from '../db.js';
import { sha256 } from './secrets.js';

export const IDLE_MS = 30 * 60_000;
// Paths are relative to the /api mount. 
export const PUBLIC_ROUTES = new Set(['GET /auth/csrf', 'POST /auth/sign-in', 'POST /auth/set-password', 'POST /auth/forgot-password']);

export interface AuthUser { id: string; name: string; role: Role }
declare global {
  namespace Express {
    interface Request { user?: AuthUser; sessionIdHash?: string; sid?: string }
  }
}

const COOKIE: CookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' };
export const setCookie = (res: Response, name: string, value: string, maxAgeMs?: number) =>
  void res.cookie(name, value, maxAgeMs === undefined ? COOKIE : { ...COOKIE, maxAge: maxAgeMs });
export const clearCookie = (res: Response, name: string) => void res.cookie(name, '', { ...COOKIE, maxAge: 0 });

export const parseCookies = (h = ''): Record<string, string> =>
  Object.fromEntries(h.split(';').map((p) => p.trim().split(/=(.*)/s)).filter((p) => p[0]).map((p) => [p[0], p[1] ?? '']));

export const csrfFor = (sid: string): string => Buffer.from(sha256('csrf\0' + sid), 'hex').toString('base64url');

export function csrfMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const authenticate = (prisma: PrismaClient, clock: Clock): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const write = !SAFE.has(req.method);
    const header = req.get('X-CSRF-Token');
    if (PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) {
      if (write && !csrfMatches(header, cookies.csrf_pre)) throw new HttpError(403, 'csrf');
      return next();
    }
    const unauth = () => { clearCookie(res, 'sid'); return new HttpError(401, 'unauthenticated'); };
    const sid = cookies.sid;
    if (!sid) throw unauth();
    const idHash = sha256(sid);
    const s = await prisma.session.findUnique({ where: { idHash }, include: { user: true } });
    if (!s || !s.user.active) throw unauth();
    const now = clock();
    if (now.getTime() - s.lastSeenAt.getTime() > IDLE_MS) {
      await withWrite(prisma, (tx) => tx.session.deleteMany({ where: { idHash } }));
      throw unauth();
    }
    if (write && !csrfMatches(header, csrfFor(sid))) throw new HttpError(403, 'csrf');
    await withWrite(prisma, (tx) => tx.session.updateMany({ where: { idHash }, data: { lastSeenAt: now } }));
    req.user = { id: s.user.id, name: s.user.name, role: s.user.role };
    req.sessionIdHash = idHash;
    req.sid = sid;
    next();
  };
