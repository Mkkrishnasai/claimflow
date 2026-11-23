import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../db.js';
import { canReadClaim, type ClaimRef, type Requester } from '../auth/authz.js';
import { HttpError } from '../middleware.js';

// C-27. The claimant's two nearest managers, read fresh from the database on every call (no cached grant).
export async function managerChain(db: PrismaClient | Tx, claimantId: string): Promise<(id: string) => string | null> {
  const chain = new Map<string, string | null>();
  let cur: string | null = claimantId;
  for (let i = 0; i < 2 && cur; i++) {
    const row: { managerId: string | null } | null = await db.user.findUnique({ where: { id: cur }, select: { managerId: true } });
    chain.set(cur, row?.managerId ?? null);
    cur = row?.managerId ?? null;
  }
  return (id) => chain.get(id) ?? null;
}

export async function requireReadable(db: PrismaClient, user: Requester | undefined, claim: ClaimRef): Promise<void> {
  if (!user || !canReadClaim(user, claim, await managerChain(db, claim.claimantId))) throw new HttpError(403, 'forbidden');
}

// C-27. Writes are claimant-only, whatever the caller's role (FR-5, ADR-31 order: 403 before status checks).
export function requireClaimant(user: Requester | undefined, claim: ClaimRef): void {
  if (!user || user.id !== claim.claimantId) throw new HttpError(403, 'forbidden');
}

// paid is reported before the generic refusal; editable = draft or rejected.
export function requireEditable(claim: ClaimRef): void {
  if (claim.status === 'paid') throw new HttpError(409, 'claim_paid');
  if (claim.status !== 'draft' && claim.status !== 'rejected') throw new HttpError(409, 'claim_not_editable');
}
