import { euro } from '../claims/export.js';

// C-39. Fixed subjects only (NFR-SEC-1); never built from user input.
export const SUBJECT = { approved: 'Your claim was approved', rejected: 'Your claim was rejected', sent_back: 'Your claim was sent back', paid: 'Your claim was paid' } as const;
export type ClaimMailKind = keyof typeof SUBJECT;
export const BATCH = 50;
export const WINDOW_MS = 2 * 3_600_000;
export const MAX_STREAK = 3;

// Delay after the n-th failed attempt (n >= 1): 1, 2, 4, 8, 15, 15 ... minutes.
export const retryDelay = (n: number): number => Math.min(60_000 * 2 ** (n - 1), 900_000);
// The window runs from queueing; an attempt at exactly createdAt + 2 h is still allowed.
export const expired = (createdAt: Date, now: Date): boolean => now.getTime() > createdAt.getTime() + WINDOW_MS;

export type NextState = { status: 'sent' } | { status: 'pending'; attempts: number; nextAttemptAt: Date } | { status: 'failed'; attempts: number };
// Outcome of one send attempt; `attempts` is the count before it.
export function nextState(ok: boolean, attempts: number, createdAt: Date, now: Date): NextState {
  if (ok) return { status: 'sent' };
  const n = attempts + 1, nextAttemptAt = new Date(now.getTime() + retryDelay(n));
  return expired(createdAt, nextAttemptAt) ? { status: 'failed', attempts: n } : { status: 'pending', attempts: n, nextAttemptAt };
}

// Strip CR/LF so user text cannot start a new header or body line.
export const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

export interface ClaimMailInput { kind: ClaimMailKind; claimId: string; title: string; totalCents: number; actorName: string; reason: string | null; paymentDate: string | null; paymentReference: string | null; publicBaseUrl: string }

export function renderClaimMail(i: ClaimMailInput): { subject: string; text: string } {
  const lines = [`Claim: ${oneLine(i.title)}`, `Total: EUR ${euro(i.totalCents)}`, `By: ${oneLine(i.actorName)}`];
  if ((i.kind === 'rejected' || i.kind === 'sent_back') && i.reason) lines.push(`Reason: ${oneLine(i.reason)}`);
  if (i.kind === 'paid') lines.push(`Payment date: ${oneLine(i.paymentDate ?? '')}`, `Payment reference: ${oneLine(i.paymentReference ?? '')}`);
  lines.push(`${i.publicBaseUrl}/claims/${i.claimId}`);
  return { subject: SUBJECT[i.kind], text: lines.join('\n') + '\n' };
}

// C-39 digest (FR-2). Due from 08:00 UTC; one key per approver per UTC date (NFR-REL-3).
export const DIGEST_SUBJECT = 'Claims waiting for your approval';
export const DIGEST_MAX = 100;
export const digestDue = (now: Date): boolean => now.getUTCHours() >= 8;
export const digestKey = (userId: string, now: Date): string => `digest:${userId}:${now.toISOString().slice(0, 10)}`;

export interface DigestItem { claimant: string; title: string; totalCents: number; submittedAt: Date | null }
// `items` holds at most DIGEST_MAX claims; `total` is the full waiting count.
export function renderDigest(items: DigestItem[], total: number, publicBaseUrl: string): { subject: string; text: string } {
  const lines = items.slice(0, DIGEST_MAX).map((c) => `${oneLine(c.claimant)} | ${oneLine(c.title)} | EUR ${euro(c.totalCents)} | ${c.submittedAt ? c.submittedAt.toISOString().slice(0, 10) : '-'}`);
  if (total > DIGEST_MAX) lines.push(`and ${total - DIGEST_MAX} more`);
  lines.push(`${publicBaseUrl}/approvals`);
  return { subject: DIGEST_SUBJECT, text: lines.join('\n') + '\n' };
}
