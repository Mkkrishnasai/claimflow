import type { ClaimStore } from '../claims-port.js';
import { appendEvent } from './status.js';

// C-28. Runs inside the caller's transaction (ADR-17/18).
export const prismaClaimStore: ClaimStore = {
  get: async (tx, id) => tx.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, approverId: true, status: true } }),
  listWaitingOn: async (tx, userId) =>
    tx.claim.findMany({ where: { approverId: userId, status: { in: ['submitted', 'approved'] } }, select: { id: true, claimantId: true, approverId: true, status: true }, orderBy: { id: 'asc' } }),
  async reassign(tx, ids, approverId, actorId) {
    const at = new Date();
    const rows = await tx.claim.findMany({ where: { id: { in: ids }, status: { in: ['submitted', 'approved'] } }, select: { id: true, status: true } });
    await tx.claim.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { approverId, updatedAt: at } });
    for (const { id: claimId, status } of rows) await appendEvent(tx, { claimId, actorId, action: 'reassigned', fromStatus: status, toStatus: status, at });
  },
};
