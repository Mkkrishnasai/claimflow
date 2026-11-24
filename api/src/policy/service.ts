import { listCategories, type ClaimDeps } from '../claims/service.js';
import { HttpError } from '../middleware.js';
import { withWrite } from '../db.js';
import { MAX_CENTS, MIN_CENTS } from '../claims/policy.js';

// FR-1: a missing Policy row is an internal error, never a silent default.
export async function readPolicy(d: ClaimDeps) {
  const [categories, row] = await Promise.all([listCategories(d), d.prisma.policy.findUnique({ where: { id: 1 } })]);
  if (!row) throw new Error('policy row missing');
  return { categories, receiptThresholdCents: row.receiptThresholdCents, secondApprovalCents: row.secondApprovalCents };
}

const bad = (reason: string) => new HttpError(422, 'invalid_input', reason);
const cents = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < MIN_CENTS || v > MAX_CENTS) throw bad(`${field} must be an integer from ${MIN_CENTS} to ${MAX_CENTS}`);
  return v;
};

// FR-2: validate everything, then apply every change in one withWrite (all or none). Only the three known fields are read.
// beforeLastWrite is a test hook: fails the transaction after earlier writes.
export async function updatePolicy(d: ClaimDeps & { beforeLastWrite?: () => void | Promise<void> }, body: Record<string, unknown>) {
  const { categoryLimits, receiptThresholdCents, secondApprovalCents } = body;
  if (categoryLimits === undefined && receiptThresholdCents === undefined && secondApprovalCents === undefined) throw bad('no policy field given');
  if (categoryLimits !== undefined && (typeof categoryLimits !== 'object' || categoryLimits === null || Array.isArray(categoryLimits))) throw bad('categoryLimits must be an object');
  const limits = Object.entries((categoryLimits ?? {}) as Record<string, unknown>).map(([code, v]) => [code, cents(v, `categoryLimits.${code}`)] as const);
  const receipt = receiptThresholdCents === undefined ? undefined : cents(receiptThresholdCents, 'receiptThresholdCents');
  const second = secondApprovalCents === undefined ? undefined : cents(secondApprovalCents, 'secondApprovalCents');

  const changed = await withWrite(d.prisma, async (tx) => {
    const cats = new Map((await tx.category.findMany({ select: { code: true, limitCents: true } })).map((c) => [c.code, c.limitCents]));
    const row = await tx.policy.findUnique({ where: { id: 1 } });
    if (!row) throw new Error('policy row missing');
    const writes: (() => Promise<unknown>)[] = [];
    const names: string[] = [];
    for (const [code, v] of limits) {
      if (!cats.has(code)) throw bad(`unknown category ${code}`);
      if (cats.get(code) !== v) { names.push(`categoryLimits.${code}`); writes.push(() => tx.category.update({ where: { code }, data: { limitCents: v } })); }
    }
    const data: Record<string, number> = {};
    if (receipt !== undefined && receipt !== row.receiptThresholdCents) { names.push('receiptThresholdCents'); data.receiptThresholdCents = receipt; }
    if (second !== undefined && second !== row.secondApprovalCents) { names.push('secondApprovalCents'); data.secondApprovalCents = second; }
    if (Object.keys(data).length) writes.push(() => tx.policy.update({ where: { id: 1 }, data }));
    for (let i = 0; i < writes.length; i++) {
      if (i === writes.length - 1) await d.beforeLastWrite?.();
      await writes[i]();
    }
    return names;
  });
  return { policy: await readPolicy(d), changed };
}
