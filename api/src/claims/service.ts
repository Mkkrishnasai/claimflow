import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { requireClaimant, requireEditable, requireReadable } from './access.js';
import type { ReceiptStore } from './receipt-storage.js';
import { withWrite, type Clock, type Tx } from '../db.js';
import { moveClaim } from './status.js';
import { checkSubmit, SubmitRefused, utcToday } from './policy.js';

export interface ClaimDeps { prisma: PrismaClient; clock: Clock; receipts: ReceiptStore; beforeAppend?: () => void | Promise<void> /* test hook: fail the history insert */ }

const bad = (reason: string) => new HttpError(422, 'invalid_input', reason);
const text = (v: unknown, field: string, min: number, max: number): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < min || t.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return t;
};

function validDate(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('date must be YYYY-MM-DD');
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw bad('date is not a calendar date');
  return v;
}

// Money is a safe integer end to end (NFR-DATA-1); reads only the five named fields (NFR-SEC-4).
export function parseLine(raw: unknown, categories: ReadonlySet<string>) {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const { amountCents, categoryCode } = b;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 1_000_000) {
    throw bad('amountCents must be an integer from 1 to 1000000');
  }
  if (typeof categoryCode !== 'string' || !categories.has(categoryCode)) throw bad('categoryCode is unknown');
  const j = b.justification;
  if (j !== undefined && j !== null && (typeof j !== 'string' || j.trim().length > 500)) throw bad('justification must be at most 500 characters');
  return { date: validDate(b.date), categoryCode, amountCents, description: text(b.description, 'description', 1, 200), justification: (typeof j === 'string' && j.trim()) || null };
}

type LineRow = { id: string; position: number; date: string; categoryCode: string; amountCents: number; description: string; justification: string | null; limitCents: number | null; receipts?: ReceiptRow[] };
type ReceiptRow = { id: string; mime: string; sizeBytes: number; originalName: string | null; uploadedAt: Date };
type EventRow = { seq: number; action: string; fromStatus: string; toStatus: string; reason: string | null; at: Date; actor: { id: string; name: string } };
type ClaimRow = { id: string; claimantId: string; title: string; purpose: string; status: string; approverId: string | null; createdAt: Date; updatedAt: Date; submittedAt: Date | null; lines: LineRow[]; events?: EventRow[] };

export function toClaimJson(c: ClaimRow, limits: ReadonlyMap<string, number>) {
  const lines = [...c.lines].sort((a, b) => a.position - b.position).map((l) => ({
    id: l.id, position: l.position, date: l.date, categoryCode: l.categoryCode, amountCents: l.amountCents, description: l.description, justification: l.justification,
    limitCents: l.limitCents, overLimit: l.amountCents > (l.limitCents ?? limits.get(l.categoryCode) ?? 0), receipts: (l.receipts ?? []).map((r) => ({ id: r.id, mime: r.mime, sizeBytes: r.sizeBytes, originalName: r.originalName, uploadedAt: r.uploadedAt })),
  }));
  const { id, claimantId, title, purpose, status, approverId, createdAt, updatedAt, submittedAt } = c;
  return { id, claimantId, title, purpose, status, approverId, totalCents: lines.reduce((s, l) => s + l.amountCents, 0), lines, history: [...(c.events ?? [])].sort((a, b) => a.seq - b.seq).map((e) => ({ seq: e.seq, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, at: e.at, actor: { id: e.actor.id, name: e.actor.name } })), createdAt, updatedAt, submittedAt };
}

// E-19
export const listCategories = (d: ClaimDeps) => d.prisma.category.findMany({ select: { code: true, label: true, limitCents: true } }); // rowid = seed order

// E-21. Validation, category lookup and insert share one transaction; every check precedes the write.
export async function createClaim(d: ClaimDeps, claimantId: string, body: Record<string, unknown>) {
  const title = text(body.title, 'title', 1, 120);
  const purpose = text(body.purpose, 'purpose', 10, 2000);
  const raw = body.lines ?? [];
  if (!Array.isArray(raw)) throw bad('lines must be an array');
  if (raw.length > 50) throw bad('A claim can have at most 50 lines');
  return withWrite(d.prisma, async (tx) => {
    const cats = await tx.category.findMany();
    const codes = new Set(cats.map((c) => c.code));
    const lines = raw.map((l, i) => ({ position: i + 1, ...parseLine(l, codes) }));
    const now = d.clock();
    const c = await tx.claim.create({ data: { claimantId, title, purpose, status: 'draft', createdAt: now, updatedAt: now, lines: { create: lines } }, include: { lines: true } });
    return toClaimJson(c, new Map(cats.map((x) => [x.code, x.limitCents])));
  });
}

// E-20
export async function listMine(d: ClaimDeps, userId: string, q: { limit?: unknown; offset?: unknown }) {
  const num = (v: unknown, def: number, min: number, max: number, f: string) => {
    if (v === undefined) return def;
    const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) throw bad(`${f} must be an integer from ${min} to ${max}`);
    return n;
  };
  const take = num(q.limit, 50, 1, 100, 'limit');
  const skip = num(q.offset, 0, 0, 1_000_000_000, 'offset');
  const rows = await d.prisma.claim.findMany({
    where: { claimantId: userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take, skip,
    select: { id: true, title: true, status: true, updatedAt: true, lines: { select: { amountCents: true } } },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, totalCents: r.lines.reduce((s, l) => s + l.amountCents, 0), lineCount: r.lines.length, updatedAt: r.updatedAt }));
}

// E-22. One query (no N+1); 404 before 403 (architecture section 6).
export async function getClaim(d: ClaimDeps, user: { id: string; role: string } | undefined, id: string) {
  const c = await d.prisma.claim.findUnique({
    where: { id },
    include: { lines: { include: { receipts: true } }, events: { include: { actor: { select: { id: true, name: true } } } } },
  });
  if (!c) throw new HttpError(404, 'not_found');
  await requireReadable(d.prisma, user, c);
  const cats = await d.prisma.category.findMany({ select: { code: true, limitCents: true } });
  return toClaimJson(c, new Map(cats.map((x) => [x.code, x.limitCents])));
}

type User = { id: string; role: string } | undefined;
const FULL = { lines: { include: { receipts: true } }, events: { include: { actor: { select: { id: true, name: true } } } } } as const;

// Order (architecture section 6): 404 claim, 403 non-claimant, 409 status. Runs inside the write transaction.
async function loadOwn(tx: Tx, user: User, id: string, editable = true) {
  const c = await tx.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, status: true } });
  if (!c) throw new HttpError(404, 'not_found');
  requireClaimant(user, c);
  if (editable) requireEditable(c);
  return c;
}
async function reload(tx: Tx, id: string) {
  const c = await tx.claim.findUniqueOrThrow({ where: { id }, include: FULL });
  const cats = await tx.category.findMany({ select: { code: true, limitCents: true } });
  return toClaimJson(c, new Map(cats.map((x) => [x.code, x.limitCents])));
}
const touch = (tx: Tx, d: ClaimDeps, id: string, data: Record<string, unknown> = {}) => tx.claim.update({ where: { id }, data: { ...data, updatedAt: d.clock() } });

// Only title and purpose are read; status stays as it is (a rejected claim stays rejected until resubmitted).
export const editClaim = (d: ClaimDeps, user: User, id: string, body: Record<string, unknown>) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  const data: Record<string, string> = {};
  if (body.title !== undefined) data.title = text(body.title, 'title', 1, 120);
  if (body.purpose !== undefined) data.purpose = text(body.purpose, 'purpose', 10, 2000);
  await touch(tx, d, id, data);
  return reload(tx, id);
});

export const addLine = (d: ClaimDeps, user: User, id: string, body: Record<string, unknown>) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  const existing = await tx.claimLine.findMany({ where: { claimId: id }, select: { position: true } });
  if (existing.length >= 50) throw bad('A claim can have at most 50 lines');
  const codes = new Set((await tx.category.findMany()).map((c) => c.code));
  const line = parseLine(body, codes);
  await tx.claimLine.create({ data: { claimId: id, position: Math.max(0, ...existing.map((l) => l.position)) + 1, ...line } });
  await touch(tx, d, id);
  return reload(tx, id);
});

async function ownLine(tx: Tx, id: string, lineId: string) {
  const l = await tx.claimLine.findFirst({ where: { id: lineId, claimId: id } });
  if (!l) throw new HttpError(404, 'not_found');
  return l;
}

// Partial patch: unsent fields keep their stored value, then the whole line is validated as on create.
export const editLine = (d: ClaimDeps, user: User, id: string, lineId: string, body: Record<string, unknown>) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  const l = await ownLine(tx, id, lineId);
  const pick = (k: 'date' | 'categoryCode' | 'amountCents' | 'description' | 'justification') => (body[k] !== undefined ? body[k] : l[k]);
  const codes = new Set((await tx.category.findMany()).map((c) => c.code));
  const line = parseLine({ date: pick('date'), categoryCode: pick('categoryCode'), amountCents: pick('amountCents'), description: pick('description'), justification: pick('justification') }, codes);
  await tx.claimLine.update({ where: { id: lineId }, data: line });
  await touch(tx, d, id);
  return reload(tx, id);
});

export const deleteLine = (d: ClaimDeps, user: User, id: string, lineId: string) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  await ownLine(tx, id, lineId);
  const keys = (await tx.receipt.findMany({ where: { lineId }, select: { storageKey: true } })).map((r) => r.storageKey);
  await tx.receipt.deleteMany({ where: { lineId } });
  await tx.claimLine.delete({ where: { id: lineId } });
  await touch(tx, d, id);
  return keys; // files are removed by the caller after commit
});

// Draft with no history only. Receipt rows go too (receipt files are CLAIM-3-S5).
export const deleteClaim = (d: ClaimDeps, user: User, id: string) => withWrite(d.prisma, async (tx) => {
  const c = await loadOwn(tx, user, id, false);
  if (c.status === 'paid') throw new HttpError(409, 'claim_paid');
  if (c.status !== 'draft') throw new HttpError(409, 'claim_not_editable');
  if (await tx.claimEvent.count({ where: { claimId: id } }) > 0) throw new HttpError(409, 'has_history');
  const keys = (await tx.receipt.findMany({ where: { claimId: id }, select: { storageKey: true } })).map((r) => r.storageKey);
  await tx.receipt.deleteMany({ where: { claimId: id } });
  await tx.claimLine.deleteMany({ where: { claimId: id } });
  await tx.claim.delete({ where: { id } });
  return keys;
});

// E-30: row goes in the transaction; the caller removes the file after commit.
export const deleteReceipt = (d: ClaimDeps, user: User, id: string, receiptId: string) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  const r = await tx.receipt.findFirst({ where: { id: receiptId, claimId: id }, select: { storageKey: true } });
  if (!r) throw new HttpError(404, 'not_found');
  await tx.receipt.delete({ where: { id: receiptId } });
  await touch(tx, d, id);
  return [r.storageKey];
});

// E-29: 404 claim, 403 not readable (current hierarchy), 404 receipt not of this claim.
export async function receiptForRead(d: ClaimDeps, user: User, id: string, receiptId: string) {
  const c = await d.prisma.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, status: true } });
  if (!c) throw new HttpError(404, 'not_found');
  await requireReadable(d.prisma, user, c);
  const r = await d.prisma.receipt.findFirst({ where: { id: receiptId, claimId: id }, select: { storageKey: true, mime: true } });
  if (!r) throw new HttpError(404, 'not_found');
  return r;
}

// Unlocked pre-check for uploads (404 claim, 403 non-claimant, 409 status, 404 line), before any body is read.
export const precheckReceipt = (d: ClaimDeps, user: User, id: string, lineId: string): Promise<void> => (async () => {
  const c = await d.prisma.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, status: true } });
  if (!c) throw new HttpError(404, 'not_found');
  requireClaimant(user, c);
  requireEditable(c);
  if (!await d.prisma.claimLine.findFirst({ where: { id: lineId, claimId: id }, select: { id: true } })) throw new HttpError(404, 'not_found');
})();

// Count and insert under the write lock; the caller removes the file if this throws.
export const addReceiptRow = (d: ClaimDeps, user: User, id: string, lineId: string, f: { storageKey: string; sha256: string; sizeBytes: number; mime: string; originalName: string | null }) => withWrite(d.prisma, async (tx) => {
  await loadOwn(tx, user, id);
  await ownLine(tx, id, lineId);
  if (await tx.receipt.count({ where: { lineId } }) >= 5) throw new HttpError(409, 'receipt_limit', 'A line can have at most 5 receipts');
  const r = await tx.receipt.create({ data: { lineId, claimId: id, uploadedById: user!.id, uploadedAt: d.clock(), ...f } });
  await touch(tx, d, id);
  return { id: r.id, mime: r.mime, sizeBytes: r.sizeBytes, originalName: r.originalName };
});

// E-31 / E-32. 404, 403 non-claimant, 409 status, then the specific refusals; every check precedes the write.
async function ownForMove(tx: Tx, user: User, id: string, from: string[]) {
  const c = await tx.claim.findUnique({ where: { id }, select: { id: true, claimantId: true, status: true, claimant: { select: { manager: { select: { id: true, active: true } } } } } });
  if (!c) throw new HttpError(404, 'not_found');
  requireClaimant(user, c);
  if (c.status === 'paid') throw new HttpError(409, 'claim_paid');
  if (!from.includes(c.status)) throw new HttpError(409, 'invalid_transition');
  return c;
}

export const submitClaim = (d: ClaimDeps, user: User, id: string) => withWrite(d.prisma, async (tx) => {
  const c = await ownForMove(tx, user, id, ['draft', 'rejected']);
  const mgr = c.claimant.manager;
  if (!mgr) throw new HttpError(409, 'no_manager', 'A user with no manager cannot submit claims');
  if (!mgr.active) throw new HttpError(409, 'manager_inactive');
  const now = d.clock();
  const full = await tx.claim.findUniqueOrThrow({ where: { id }, select: { title: true, purpose: true, lines: { select: { id: true, position: true, date: true, categoryCode: true, amountCents: true, justification: true, _count: { select: { receipts: true } } } } } });
  const cats = await tx.category.findMany({ select: { code: true, limitCents: true } });
  const failures = checkSubmit({ ...full, lines: full.lines.map(({ _count, ...l }) => ({ ...l, receiptCount: _count.receipts })) }, new Map(cats.map((x) => [x.code, x.limitCents])), utcToday(now));
  if (failures.length) throw new SubmitRefused(failures, c.status); // before the first write
  const ev = await moveClaim(tx, { claimId: id, action: c.status === 'draft' ? 'submit' : 'resubmit', actorId: user!.id, now, set: { approverId: mgr.id, submittedAt: now, updatedAt: now }, beforeAppend: d.beforeAppend });
  await tx.$executeRaw`UPDATE "ClaimLine" SET "limitCents" = (SELECT "limitCents" FROM "Category" WHERE "code" = "ClaimLine"."categoryCode") WHERE "claimId" = ${id}`;
  return { claim: await reload(tx, id), ev };
});

export const withdrawClaim = (d: ClaimDeps, user: User, id: string, body: Record<string, unknown>) => withWrite(d.prisma, async (tx) => {
  await ownForMove(tx, user, id, ['submitted']);
  const reason = body.reason === undefined || body.reason === null ? null : typeof body.reason === 'string' && body.reason.length <= 500 ? body.reason : (() => { throw bad('reason must be at most 500 characters'); })();
  const now = d.clock();
  const ev = await moveClaim(tx, { claimId: id, action: 'withdraw', actorId: user!.id, reason, now, set: { approverId: null, submittedAt: null, updatedAt: now }, beforeAppend: d.beforeAppend });
  return { claim: await reload(tx, id), ev };
});
