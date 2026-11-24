import type { PrismaClient } from '@prisma/client';
import { withWrite, type Clock } from '../db.js';
import { serializeError, type Logger } from '../logger.js';
import type { Mailer } from '../mailer.js';
import { BATCH, DIGEST_MAX, MAX_STREAK, digestDue, digestKey, expired, nextState, renderClaimMail, renderDigest } from './rules.js';

export interface DispatcherDeps { prisma: PrismaClient; clock: Clock; mailer: Mailer; log: Logger; publicBaseUrl: string; sendTimeoutMs?: number }

// ADR-54: one probe outside the lock, one createMany under it; 2 queries however many approvers.
async function enqueueDigests(prisma: PrismaClient, now: Date): Promise<void> {
  if (!digestDue(now)) return;
  const day = digestKey('', now).slice(7); // ':<date>' tail shared with digestKey
  const ids = await prisma.$queryRaw<{ approverId: string }[]>`SELECT DISTINCT c.approverId FROM Claim c WHERE c.approverId IS NOT NULL AND c.status IN ('submitted','approved') AND NOT EXISTS (SELECT 1 FROM Notification n WHERE n.dedupeKey = 'digest:' || c.approverId || ${day})`;
  if (!ids.length) return;
  await withWrite(prisma, (tx) => tx.notification.createMany({ data: ids.map((r) => ({ kind: 'digest' as const, userId: r.approverId, dedupeKey: digestKey(r.approverId, now), nextAttemptAt: now, createdAt: now })) }));
}

// C-40. Send happens outside any transaction; only the result is written under withWrite (NFR-PERF-2).
export async function runOnce({ prisma, clock, mailer, log, publicBaseUrl, sendTimeoutMs = 20_000 }: DispatcherDeps): Promise<void> {
  const now = clock();
  try { await enqueueDigests(prisma, now); } catch (e) { log.error('mail', { mailEvent: 'retry', kind: 'digest', error: serializeError(e) }); } // unique key rejects a racing insert; next tick retries
  const due = await prisma.notification.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: BATCH });
  let streak = 0;
  for (const n of due) {
    const base = { kind: n.kind, notificationId: n.id };
    try {
      const [user, claim, ev] = await Promise.all([
        prisma.user.findUnique({ where: { id: n.userId }, select: { email: true } }),
        n.claimId ? prisma.claim.findUnique({ where: { id: n.claimId }, include: { lines: { select: { amountCents: true } } } }) : null,
        n.claimId && n.eventSeq != null ? prisma.claimEvent.findUnique({ where: { claimId_seq: { claimId: n.claimId, seq: n.eventSeq } }, include: { actor: { select: { name: true } } } }) : null,
      ]);
      if (expired(n.createdAt, clock())) { // deadline passed: no attempt, not a streak failure
        await withWrite(prisma, (tx) => tx.notification.updateMany({ where: { id: n.id, status: 'pending' }, data: { status: 'failed' } }));
        log.warn('mail', { ...base, mailEvent: 'failed', attempts: n.attempts });
        continue;
      }
      let mail: { subject: string; text: string } | undefined;
      if (n.kind === 'digest' && user) { // list is read at send time (FR-2 AC-5)
        const where = { approverId: n.userId, status: { in: ['submitted', 'approved'] as ('submitted' | 'approved')[] } };
        const [total, waiting] = await Promise.all([
          prisma.claim.count({ where }),
          prisma.claim.findMany({ where, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }], take: DIGEST_MAX, select: { title: true, submittedAt: true, claimant: { select: { name: true } }, lines: { select: { amountCents: true } } } }),
        ]);
        if (!total) {
          await withWrite(prisma, (tx) => tx.notification.updateMany({ where: { id: n.id, status: 'pending' }, data: { status: 'skipped' } }));
          log.info('mail', { ...base, mailEvent: 'skipped', attempts: n.attempts });
          continue;
        }
        mail = renderDigest(waiting.map((c) => ({ claimant: c.claimant.name, title: c.title, totalCents: c.lines.reduce((s, l) => s + l.amountCents, 0), submittedAt: c.submittedAt })), total, publicBaseUrl);
      } else if (user && claim && ev && n.kind !== 'digest') {
        mail = renderClaimMail({ kind: n.kind, claimId: claim.id, title: claim.title, totalCents: claim.lines.reduce((s, l) => s + l.amountCents, 0), actorName: ev.actor.name, reason: ev.reason, paymentDate: claim.paymentDate, paymentReference: claim.paymentReference, publicBaseUrl });
      }
      if (!mail || !user) {
        await withWrite(prisma, (tx) => tx.notification.update({ where: { id: n.id }, data: { status: 'failed' } }));
        log.warn('mail', { ...base, mailEvent: 'render_failed', attempts: n.attempts });
        continue;
      }
      const { subject, text } = mail;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([mailer.notifyMail(user.email, subject, text), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('send timeout')), sendTimeoutMs); })]);
      } catch (e) {
        const s = nextState(false, n.attempts, n.createdAt, clock());
        const data = s.status === 'pending' ? { attempts: s.attempts, nextAttemptAt: s.nextAttemptAt } : { status: 'failed' as const, attempts: (s as { attempts: number }).attempts };
        await withWrite(prisma, (tx) => tx.notification.updateMany({ where: { id: n.id, status: 'pending' }, data }));
        log.warn('mail', { ...base, mailEvent: s.status === 'failed' ? 'failed' : 'retry', attempts: n.attempts + 1, error: serializeError(e) });
        if (++streak >= MAX_STREAK) break;
        continue;
      } finally { clearTimeout(timer); }
      streak = 0;
      await withWrite(prisma, (tx) => tx.notification.updateMany({ where: { id: n.id, status: 'pending' }, data: { status: 'sent', sentAt: clock() } }));
      log.info('mail', { ...base, mailEvent: 'sent', attempts: n.attempts });
    } catch (e) {
      log.error('mail', { ...base, mailEvent: 'retry', attempts: n.attempts, error: serializeError(e) }); // DB error: row stays pending, retried next run
    }
  }
}

// Every 30 s, unref'd, never overlapping: next tick is armed only after the run settles.
export function startDispatcher(deps: DispatcherDeps): () => void {
  let timer: NodeJS.Timeout | undefined, stopped = false;
  const arm = () => { if (!stopped) { timer = setTimeout(tick, 30_000); timer.unref(); } };
  const tick = () => { runOnce(deps).catch((e) => deps.log.error('dispatcher', { error: serializeError(e) })).finally(arm); };
  arm();
  return () => { stopped = true; clearTimeout(timer); };
}
