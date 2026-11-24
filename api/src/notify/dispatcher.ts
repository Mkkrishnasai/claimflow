import type { PrismaClient } from '@prisma/client';
import { withWrite, type Clock } from '../db.js';
import { serializeError, type Logger } from '../logger.js';
import type { Mailer } from '../mailer.js';
import { BATCH, renderClaimMail } from './rules.js';

export interface DispatcherDeps { prisma: PrismaClient; clock: Clock; mailer: Mailer; log: Logger; publicBaseUrl: string }

// C-40. Send happens outside any transaction; only the result is written under withWrite (NFR-PERF-2).
// ponytail: S3 is the send path only; back-off, deadline, streak and timeout land in S4, so a failure just retries in 60 s.
export async function runOnce({ prisma, clock, mailer, log, publicBaseUrl }: DispatcherDeps): Promise<void> {
  const now = clock();
  const due = await prisma.notification.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: BATCH });
  for (const n of due) {
    const base = { kind: n.kind, notificationId: n.id };
    try {
      const [user, claim, ev] = await Promise.all([
        prisma.user.findUnique({ where: { id: n.userId }, select: { email: true } }),
        n.claimId ? prisma.claim.findUnique({ where: { id: n.claimId }, include: { lines: { select: { amountCents: true } } } }) : null,
        n.claimId && n.eventSeq != null ? prisma.claimEvent.findUnique({ where: { claimId_seq: { claimId: n.claimId, seq: n.eventSeq } }, include: { actor: { select: { name: true } } } }) : null,
      ]);
      if (!user || !claim || !ev || n.kind === 'digest') {
        await withWrite(prisma, (tx) => tx.notification.update({ where: { id: n.id }, data: { status: 'failed' } }));
        log.warn('mail', { ...base, mailEvent: 'render_failed', attempts: n.attempts });
        continue;
      }
      const { subject, text } = renderClaimMail({ kind: n.kind, claimId: claim.id, title: claim.title, totalCents: claim.lines.reduce((s, l) => s + l.amountCents, 0), actorName: ev.actor.name, reason: ev.reason, paymentDate: claim.paymentDate, paymentReference: claim.paymentReference, publicBaseUrl });
      try {
        await mailer.notifyMail(user.email, subject, text);
      } catch (e) {
        const next = new Date(clock().getTime() + 60_000);
        await withWrite(prisma, (tx) => tx.notification.update({ where: { id: n.id }, data: { attempts: n.attempts + 1, nextAttemptAt: next } }));
        log.warn('mail', { ...base, mailEvent: 'retry', attempts: n.attempts + 1, error: serializeError(e) });
        continue;
      }
      await withWrite(prisma, (tx) => tx.notification.update({ where: { id: n.id }, data: { status: 'sent', sentAt: clock() } }));
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
