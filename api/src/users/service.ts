import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock, type Tx } from '../db.js';
import { randomToken, sha256 } from '../auth/secrets.js';
import { isManagerRole } from '../auth/authz.js';
import type { Mailer } from '../mailer.js';
import { NoClaimStore, type ClaimStore } from '../claims-port.js';

const ROLES: readonly string[] = ['employee', 'manager', 'finance', 'admin'];
const bad = (reason: string) => new HttpError(400, 'invalid_input', reason);
export const TOKEN_TTL_MS = 24 * 3_600_000;

export const publicUser = (u: { id: string; name: string; email: string; role: Role; managerId: string | null; active: boolean }) =>
  ({ id: u.id, name: u.name, email: u.email, role: u.role, managerId: u.managerId, active: u.active });

export interface UserDeps { prisma: PrismaClient; clock: Clock; mailer: Mailer; publicBaseUrl: string; claims?: ClaimStore }

// E-13. Loop walk and write share one withWrite transaction; walk bounded by user count.
export async function setManager(d: UserDeps, id: string, body: Record<string, unknown>) {
  const { managerId } = body;
  if (managerId !== null && typeof managerId !== 'string') throw bad('managerId must be a string or null');
  const u = await withWrite(d.prisma, async (tx) => {
    if (!(await tx.user.findUnique({ where: { id } }))) throw new HttpError(404, 'not_found');
    if (managerId !== null) {
      const m = await tx.user.findUnique({ where: { id: managerId } });
      if (!m) throw new HttpError(409, 'hierarchy_violation', 'manager does not exist');
      if (!m.active) throw new HttpError(409, 'hierarchy_violation', 'manager is inactive');
      let cur: string | null = managerId;
      for (let n = await tx.user.count(); cur && n >= 0; n--) {
        if (cur === id) throw new HttpError(409, 'hierarchy_violation', 'manager assignment would create a loop');
        cur = (await tx.user.findUnique({ where: { id: cur }, select: { managerId: true } }))?.managerId ?? null;
      }
      if (!isManagerRole(m.role)) throw new HttpError(409, 'hierarchy_violation', 'manager must have role manager'); // Q-13
    }
    return tx.user.update({ where: { id }, data: { managerId } });
  });
  return publicUser(u);
}

// E-12. Row + token commit together; the email goes out after commit, and its failure never undoes the user.
export async function createUser(d: UserDeps, body: Record<string, unknown>) {
  const { name, email, role, managerId } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw bad('name must be 1-100 characters');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw bad('email is invalid');
  if (typeof role !== 'string' || !ROLES.includes(role)) throw bad('role is invalid');
  if (managerId != null && typeof managerId !== 'string') throw bad('managerId must be a string or null');
  const raw = randomToken();
  let user;
  try {
    user = await withWrite(d.prisma, async (tx) => {
      if (managerId) {
        const m = await tx.user.findUnique({ where: { id: managerId } });
        if (!m) throw new HttpError(409, 'hierarchy_violation', 'manager does not exist');
        if (!m.active) throw new HttpError(409, 'hierarchy_violation', 'manager is inactive');
        if (!isManagerRole(m.role)) throw new HttpError(409, 'hierarchy_violation', 'manager must have role manager'); // Q-13
      }
      const u = await tx.user.create({ data: { name: name.trim(), email: email.trim().toLowerCase(), role: role as Role, managerId: managerId ?? null, passwordHash: null } });
      await tx.oneTimeToken.create({ data: { hash: sha256(raw), userId: u.id, purpose: 'set_password', expiresAt: new Date(d.clock().getTime() + TOKEN_TTL_MS) } });
      return u;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new HttpError(409, 'email_taken');
    throw e;
  }
  try {
    await d.mailer.linkMail('set_password', user.email, `${d.publicBaseUrl}/set-password#token=${raw}`);
  } catch {
    throw new HttpError(502, 'smtp_unavailable');
  }
  return publicUser(user);
}

// E-14. Swap unused set_password tokens for a fresh one in one transaction; mail after commit.
export async function resendLink(d: UserDeps, id: string) {
  const raw = randomToken();
  const email = await withWrite(d.prisma, async (tx) => {
    const u = await tx.user.findUnique({ where: { id } });
    if (!u) throw new HttpError(404, 'not_found');
    if (!u.active) throw new HttpError(409, 'user_inactive');
    if (u.passwordHash !== null) throw new HttpError(409, 'password_already_set');
    await tx.oneTimeToken.deleteMany({ where: { userId: id, purpose: 'set_password', usedAt: null } });
    await tx.oneTimeToken.create({ data: { hash: sha256(raw), userId: id, purpose: 'set_password', expiresAt: new Date(d.clock().getTime() + TOKEN_TTL_MS) } });
    return u.email;
  });
  try {
    await d.mailer.linkMail('set_password', email, `${d.publicBaseUrl}/set-password#token=${raw}`);
  } catch {
    throw new HttpError(502, 'smtp_unavailable');
  }
}

// C-18. First active manager walking up from userId (bounded by the user count, so a cycle cannot loop).
export async function nearestActiveAbove(tx: Tx, userId: string): Promise<string | null> {
  let cur = (await tx.user.findUnique({ where: { id: userId }, select: { managerId: true } }))?.managerId ?? null;
  for (let n = await tx.user.count(); cur && n >= 0; n--) {
    const a = await tx.user.findUnique({ where: { id: cur }, select: { id: true, active: true, managerId: true } });
    if (!a) break;
    if (a.active) return a.id;
    cur = a.managerId;
  }
  return null;
}

const MAIL_DEADLINE_MS = 15_000;

// E-15. One transaction: update, sessions, then reassign last (ADR-18). Mail after commit under one 15 s deadline; failures never roll back (Q-9).
export async function deactivateUser(d: UserDeps, id: string, actorId: string) {
  const claims = d.claims ?? NoClaimStore;
  const { moved, mails } = await withWrite(d.prisma, async (tx) => {
    const u = await tx.user.findUnique({ where: { id } });
    if (!u) throw new HttpError(404, 'not_found');
    if (!u.active) throw new HttpError(409, 'already_inactive');
    const admins = await tx.user.findMany({ where: { role: 'admin', active: true }, select: { id: true } });
    if (admins.length === 1 && admins[0].id === id)
      throw new HttpError(409, 'last_admin', 'the last active admin cannot be deactivated');
    const waiting = await claims.listWaitingOn(tx, id);
    let target: string | null = null;
    if (waiting.length) {
      target = await nearestActiveAbove(tx, id);
      if (!target) throw new HttpError(409, 'would_strand_claims', 'claims are waiting on this user and no active manager exists above them');
    }
    await tx.user.update({ where: { id }, data: { active: false } });
    await tx.session.deleteMany({ where: { userId: id } });
    const mails: { to: string | null; claimId: string }[] = [];
    if (target) {
      for (const c of waiting) mails.push({ to: (await tx.user.findUnique({ where: { id: c.claimantId }, select: { email: true } }))?.email ?? null, claimId: c.id });
      await claims.reassign(tx, waiting.map((c) => c.id), target, actorId);
    }
    return { moved: waiting.length, mails };
  });
  let notified = 0;
  let timer: NodeJS.Timeout | undefined;
  const sends = mails.map((m) => m.to ? d.mailer.reassignedMail(m.to, m.claimId).then(() => { notified++; }, () => undefined) : Promise.resolve());
  await Promise.race([Promise.allSettled(sends), new Promise((r) => { timer = setTimeout(r, MAIL_DEADLINE_MS); })]);
  clearTimeout(timer);
  return { id, active: false, reassignedClaims: moved, notified };
}

const LIST_SELECT = { id: true, name: true, email: true, role: true, managerId: true, active: true, manager: { select: { name: true, active: true } } } as const;
type Row = { id: string; name: string; email: string; role: Role; managerId: string | null; active: boolean; manager: { name: string; active: boolean } | null };
const listItem = (u: Row) => ({ ...publicUser(u), managerName: u.manager?.name ?? null, managerInactive: u.manager ? !u.manager.active : false });

// E-10
export async function listUsers(d: UserDeps) {
  return (await d.prisma.user.findMany({ select: LIST_SELECT, orderBy: { name: 'asc' } })).map(listItem);
}

// E-11. Caller has already passed canReadUser; 404 only for an admin asking for an unknown id.
export async function getUser(d: UserDeps, id: string) {
  const u = await d.prisma.user.findUnique({ where: { id }, select: { ...LIST_SELECT, passwordHash: true, reports: { select: { id: true, name: true }, orderBy: { name: 'asc' } } } });
  if (!u) throw new HttpError(404, 'not_found');
  const a = await d.prisma.loginAttempt.findUnique({ where: { kind_email: { kind: 'sign_in', email: u.email } } });
  const lockedUntil = a?.lockedUntil && a.lockedUntil > d.clock() ? a.lockedUntil.toISOString() : null;
  return { ...listItem(u), reports: u.reports, lockedUntil, passwordSet: u.passwordHash !== null };
}
