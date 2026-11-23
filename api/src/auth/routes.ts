import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock } from '../db.js';
import { randomToken, sha256, verifyPassword } from './secrets.js';
import { clearCookie, csrfFor, parseCookies, setCookie } from './session.js';

const invalid = () => new HttpError(401, 'invalid_credentials');

export function authRoutes(prisma: PrismaClient, clock: Clock): Router {
  const r = Router();

  // E-4
  r.get('/auth/csrf', (_req, res) => {
    const csrfToken = randomToken();
    setCookie(res, 'csrf_pre', csrfToken, 7_200_000);
    res.json({ csrfToken });
  });

  // E-5. bcrypt runs outside withWrite; the transaction re-checks state (arch 5.3). Lock-out maths arrive in S3.
  r.post('/auth/sign-in', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254) throw new HttpError(400, 'bad_request');
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const hash = user?.active ? user.passwordHash : null;
    if (!(await verifyPassword(password, hash)) || !user) throw invalid();
    const sid = randomToken();
    const old = parseCookies(req.headers.cookie).sid;
    const now = clock();
    await withWrite(prisma, async (tx) => {
      const u = await tx.user.findUnique({ where: { id: user.id } });
      if (!u?.active || u.passwordHash !== hash) throw invalid();
      if (old) await tx.session.deleteMany({ where: { idHash: sha256(old) } });
      await tx.session.create({
        data: { idHash: sha256(sid), csrfHash: '', userId: u.id, createdAt: now, lastSeenAt: now }, // csrfHash unused: ADR-14 derives the token
      });
    });
    setCookie(res, 'sid', sid);
    clearCookie(res, 'csrf_pre');
    res.json({ id: user.id, name: user.name, role: user.role, csrfToken: csrfFor(sid) });
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
