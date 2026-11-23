import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock } from '../db.js';
import { checkPassword, hashPassword, needsRehash, randomToken, sha256, verifyPassword } from './secrets.js';
import { clearFailures, isLocked, recordFailure } from './throttle.js';
import { clearCookie, csrfFor, parseCookies, setCookie } from './session.js';

const invalid = () => new HttpError(401, 'invalid_credentials');

export function authRoutes(prisma: PrismaClient, clock: Clock, verify: typeof verifyPassword = verifyPassword): Router {
  const r = Router();

  // E-4
  r.get('/auth/csrf', (_req, res) => {
    const csrfToken = randomToken();
    setCookie(res, 'csrf_pre', csrfToken, 7_200_000);
    res.json({ csrfToken });
  });

  // E-5. bcrypt runs outside withWrite; the transaction re-checks state (arch 5.3). Lock maths in throttle.ts.
  r.post('/auth/sign-in', async (req, res) => {
    const { email: rawEmail, password } = req.body ?? {};
    if (typeof rawEmail !== 'string' || typeof password !== 'string' || rawEmail.length > 254) throw new HttpError(400, 'bad_request');
    const email = rawEmail.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    const hash = user?.active ? user.passwordHash : null;
    res.locals.logFields = { authEvent: 'sign_in_failed', ...(user && { userId: user.id }) };
    // A locked request is refused before the password is evaluated; the dummy compare keeps timing equal (NFR-SEC-6).
    if (await isLocked(prisma, email, clock())) {
      await verify(password, null);
      res.locals.logFields.authEvent = 'sign_in_locked';
      throw invalid();
    }
    if (!(await verify(password, hash)) || !user) {
      const { locked } = await withWrite(prisma, async (tx) => {
        const now = clock();
        if (await isLocked(tx, email, now)) return { locked: false }; // concurrent lock: write nothing
        return recordFailure(tx, email, now);
      });
      if (locked) res.locals.logFields.event = 'lock_started';
      throw invalid();
    }
    const upgraded = hash && needsRehash(hash) ? await hashPassword(password) : null; // bcrypt outside withWrite (ADR-17)
    const sid = randomToken();
    const old = parseCookies(req.headers.cookie).sid;
    const now = clock();
    await withWrite(prisma, async (tx) => {
      const u = await tx.user.findUnique({ where: { id: user.id } });
      if (!u?.active || u.passwordHash !== hash || (await isLocked(tx, email, now))) throw invalid();
      await clearFailures(tx, email);
      if (upgraded) await tx.user.update({ where: { id: u.id }, data: { passwordHash: upgraded } });
      if (old) await tx.session.deleteMany({ where: { idHash: sha256(old) } });
      await tx.session.create({
        data: { idHash: sha256(sid), csrfHash: '', userId: u.id, createdAt: now, lastSeenAt: now }, // csrfHash unused: ADR-14 derives the token
      });
    });
    res.locals.logFields = { authEvent: 'sign_in_ok', userId: user.id };
    setCookie(res, 'sid', sid);
    clearCookie(res, 'csrf_pre');
    res.json({ id: user.id, name: user.name, role: user.role, csrfToken: csrfFor(sid) });
  });

  // E-8. Password checked and hashed before the transaction; the conditional update is the single-use gate (arch 5.3).
  r.post('/auth/set-password', async (req, res) => {
    const { token, password } = req.body ?? {};
    checkPassword(password);
    if (typeof token !== 'string' || token.length > 200) throw new HttpError(400, 'invalid_token');
    const passwordHash = await hashPassword(password);
    const now = clock();
    await withWrite(prisma, async (tx) => {
      const { count } = await tx.oneTimeToken.updateMany({
        where: { hash: sha256(token), purpose: 'set_password', usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count !== 1) throw new HttpError(400, 'invalid_token');
      const t = await tx.oneTimeToken.findUniqueOrThrow({ where: { hash: sha256(token) }, include: { user: true } });
      if (!t.user.active) throw new HttpError(400, 'invalid_token'); // rolls back usedAt
      await tx.user.update({ where: { id: t.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: t.userId } });
    });
    res.json({ ok: true });
  });

  // E-6
  r.post('/auth/sign-out', async (req, res) => {
    await withWrite(prisma, (tx) => tx.session.deleteMany({ where: { idHash: req.sessionIdHash } }));
    clearCookie(res, 'sid');
    res.status(204).end();
  });

  // E-9
  r.get('/auth/session', (req, res) => {
    res.json({ ...req.user, csrfToken: csrfFor(req.sid!) });
  });

  return r;
}
