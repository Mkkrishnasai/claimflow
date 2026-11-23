import type { ClaimStore } from '../claims-port.js';
import { appendEvent } from './status.js';

// C-28. Runs inside the caller's transaction (ADR-17/18).
export const prismaClaimStore: ClaimStore = {
  get: async (tx, id) => tx.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, approverId: true, status: true } }),
  listWaitingOn: async (tx, userId) =>
    tx.claim.findMany({ where: { approverId: userId, status: 'submitted' }, select: { id: true, claimantId: true, approverId: true, status: true }, orderBy: { id: 'asc' } }),
  async reassign(tx, ids, approverId, actorId) {
    const at = new Date();
    await tx.claim.updateMany({ where: { id: { in: ids }, status: 'submitted' }, data: { approverId, updatedAt: at } });
    for (const claimId of ids) await appendEvent(tx, { claimId, actorId, action: 'reassigned', fromStatus: 'submitted', toStatus: 'submitted', at });
  },
};
