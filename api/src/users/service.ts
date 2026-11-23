import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock } from '../db.js';
import { randomToken, sha256 } from '../auth/secrets.js';
import type { Mailer } from '../mailer.js';

const ROLES: readonly string[] = ['employee', 'manager', 'finance', 'admin'];
const bad = (reason: string) => new HttpError(400, 'invalid_input', reason);
export const TOKEN_TTL_MS = 24 * 3_600_000;

export const publicUser = (u: { id: string; name: string; email: string; role: Role; managerId: string | null; active: boolean }) =>
  ({ id: u.id, name: u.name, email: u.email, role: u.role, managerId: u.managerId, active: u.active });

export interface UserDeps { prisma: PrismaClient; clock: Clock; mailer: Mailer; publicBaseUrl: string }

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
        if (m.role !== 'manager') throw new HttpError(409, 'hierarchy_violation', 'manager must have role manager'); // Q-13
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
