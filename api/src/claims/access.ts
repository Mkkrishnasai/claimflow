import type { PrismaClient } from '@prisma/client';
import { canReadClaim, type ClaimRef, type Requester } from '../auth/authz.js';
import { HttpError } from '../middleware.js';

// C-27. The claimant's two nearest managers, read fresh from the database on every call (no cached grant).
export async function managerChain(db: PrismaClient, claimantId: string): Promise<(id: string) => string | null> {
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
