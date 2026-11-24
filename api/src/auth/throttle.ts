import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../db.js';

const WINDOW_MS = 15 * 60_000;
const LIMIT = 5;
const KIND = 'sign_in';
type Db = PrismaClient | Tx;
const key = (email: string) => ({ kind_email: { kind: KIND, email } });

// Lock = lockedUntil in the future. Callers pass the normalised (lowercase) email.
export async function isLocked(db: Db, email: string, now: Date): Promise<boolean> {
  const row = await db.loginAttempt.findUnique({ where: key(email) });
  return !!row?.lockedUntil && now < row.lockedUntil;
}

// Caller must have checked isLocked (a locked account is never written). Writes go through withWrite (ADR-17).
export async function recordFailure(tx: Tx, email: string, now: Date): Promise<{ locked: boolean }> {
  const row = await tx.loginAttempt.findUnique({ where: key(email) });
  if (!row || now.getTime() >= row.windowStart.getTime() + WINDOW_MS) {
    await tx.loginAttempt.upsert({
      where: key(email),
      create: { kind: KIND, email, windowStart: now, count: 1 },
      update: { windowStart: now, count: 1, lockedUntil: null },
    });
    return { locked: false };
  }
  const count = row.count + 1;
  const locked = count === LIMIT;
  await tx.loginAttempt.update({
    where: key(email),
    data: { count, ...(locked && { lockedUntil: new Date(now.getTime() + WINDOW_MS) }) },
  });
  return { locked };
}

export const clearFailures = (tx: Tx, email: string) =>
  tx.loginAttempt.deleteMany({ where: { kind: KIND, email } });

// E-7 / ADR-22. 3 forgot-password requests per normalised email per hour, known or unknown alike. Returns false when over quota (nothing is written then).
const FORGOT_LIMIT = 3;
const FORGOT_WINDOW_MS = 3_600_000;
export async function takeForgotSlot(tx: Tx, email: string, now: Date): Promise<boolean> {
  const k = { kind_email: { kind: 'forgot', email } };
  const row = await tx.loginAttempt.findUnique({ where: k });
  if (!row || now.getTime() >= row.windowStart.getTime() + FORGOT_WINDOW_MS) {
    await tx.loginAttempt.upsert({ where: k, create: { kind: 'forgot', email, windowStart: now, count: 1 }, update: { windowStart: now, count: 1 } });
    return true;
  }
  if (row.count >= FORGOT_LIMIT) return false;
  await tx.loginAttempt.update({ where: k, data: { count: row.count + 1 } });
  return true;
}

// CR-1: per-IP limits on top of the per-email ones. Rows reuse LoginAttempt with the IP in `email`. req.ip honours X-Forwarded-For only from loopback (`trust proxy` in app.ts); a non-loopback front proxy needs its own setting.
const IP_SIGN_IN_LIMIT = 20; // failed sign-ins per IP per 15 min
const IP_FORGOT_LIMIT = 10; // forgot-password requests per IP per hour
export const RETENTION_MS = 24 * 3_600_000;

// Deletes counters whose window ended more than 24 h ago. Called inside the writes below, so no timer is needed.
export const purgeOld = (tx: Tx, now: Date) =>
  tx.loginAttempt.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - RETENTION_MS) } } });

export async function ipBlocked(db: Db, ip: string, now: Date): Promise<boolean> {
  const row = await db.loginAttempt.findUnique({ where: { kind_email: { kind: 'sign_in_ip', email: ip } } });
  return !!row && now.getTime() < row.windowStart.getTime() + WINDOW_MS && row.count >= IP_SIGN_IN_LIMIT;
}

async function bump(tx: Tx, kind: string, ip: string, windowMs: number, now: Date) {
  const k = { kind_email: { kind, email: ip } };
  const row = await tx.loginAttempt.findUnique({ where: k });
  if (!row || now.getTime() >= row.windowStart.getTime() + windowMs) {
    await tx.loginAttempt.upsert({ where: k, create: { kind, email: ip, windowStart: now, count: 1 }, update: { windowStart: now, count: 1 } });
    return 1;
  }
  await tx.loginAttempt.update({ where: k, data: { count: row.count + 1 } });
  return row.count + 1;
}

export async function recordIpFailure(tx: Tx, ip: string, now: Date): Promise<void> {
  await purgeOld(tx, now);
  await bump(tx, 'sign_in_ip', ip, WINDOW_MS, now);
}

// False when the IP is over its hourly forgot-password quota (nothing else is written then).
export async function takeForgotIpSlot(tx: Tx, ip: string, now: Date): Promise<boolean> {
  await purgeOld(tx, now);
  const row = await tx.loginAttempt.findUnique({ where: { kind_email: { kind: 'forgot_ip', email: ip } } });
  if (row && now.getTime() < row.windowStart.getTime() + FORGOT_WINDOW_MS && row.count >= IP_FORGOT_LIMIT) return false;
  await bump(tx, 'forgot_ip', ip, FORGOT_WINDOW_MS, now);
  return true;
}
