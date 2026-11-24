import { listCategories, type ClaimDeps } from '../claims/service.js';

// FR-1: a missing Policy row is an internal error, never a silent default.
export async function readPolicy(d: ClaimDeps) {
  const [categories, row] = await Promise.all([listCategories(d), d.prisma.policy.findUnique({ where: { id: 1 } })]);
  if (!row) throw new Error('policy row missing');
  return { categories, receiptThresholdCents: row.receiptThresholdCents, secondApprovalCents: row.secondApprovalCents };
}
