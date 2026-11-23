import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware.js';
import { withWrite, type Clock } from '../db.js';

export interface ClaimDeps { prisma: PrismaClient; clock: Clock }

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

// Money is a safe integer end to end (NFR-DATA-1); reads only the four named fields (NFR-SEC-4).
export function parseLine(raw: unknown, categories: ReadonlySet<string>) {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const { amountCents, categoryCode } = b;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 1_000_000) {
    throw bad('amountCents must be an integer from 1 to 1000000');
  }
  if (typeof categoryCode !== 'string' || !categories.has(categoryCode)) throw bad('categoryCode is unknown');
  return { date: validDate(b.date), categoryCode, amountCents, description: text(b.description, 'description', 1, 200) };
}

type LineRow = { id: string; position: number; date: string; categoryCode: string; amountCents: number; description: string; limitCents: number | null };
type ClaimRow = { id: string; claimantId: string; title: string; purpose: string; status: string; approverId: string | null; createdAt: Date; updatedAt: Date; submittedAt: Date | null; lines: LineRow[] };

export function toClaimJson(c: ClaimRow, limits: ReadonlyMap<string, number>) {
  const lines = [...c.lines].sort((a, b) => a.position - b.position).map((l) => ({
    id: l.id, position: l.position, date: l.date, categoryCode: l.categoryCode, amountCents: l.amountCents, description: l.description,
    limitCents: l.limitCents, overLimit: l.amountCents > (l.limitCents ?? limits.get(l.categoryCode) ?? 0), receipts: [] as unknown[],
  }));
  const { id, claimantId, title, purpose, status, approverId, createdAt, updatedAt, submittedAt } = c;
  return { id, claimantId, title, purpose, status, approverId, totalCents: lines.reduce((s, l) => s + l.amountCents, 0), lines, history: [] as unknown[], createdAt, updatedAt, submittedAt };
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
