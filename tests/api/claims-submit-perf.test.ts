import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { findDuplicates, submitClaim } from '../../api/src/claims/service.js';
import { receiptStorage } from '../../api/src/claims/receipt-storage.js';
import { withWrite } from '../../api/src/db.js';

const prisma = new PrismaClient();
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));
const deps = { prisma, clock, receipts: receiptStorage(mkdtempSync(join(tmpdir(), 'r-'))) };
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
after(async () => { await wipe(); await prisma.$disconnect(); });

const mkLines = (n: number, claimId: string, i = 0) => Array.from({ length: n }, (_, p) => ({ claimId, position: p + 1, date: `2025-12-${String(1 + ((i + p) % 28)).padStart(2, '0')}`, categoryCode: 'meals', amountCents: 100 + ((i * 7 + p) % 4000), description: 'x' }));

test('AC-6 constant query count, index use and p95 under 1 s at 10,000 claims / 30,000 lines', async () => {
  await wipe();
  await prisma.user.createMany({ data: [{ id: 'mgr', email: 'mgr@claimflow.test', name: 'mgr', role: 'manager' as never, passwordHash: await bcrypt.hash('x', 4) }, { id: 'emp', email: 'emp@claimflow.test', name: 'emp', role: 'employee' as never, managerId: 'mgr', passwordHash: 'x' }, { id: 'oth', email: 'oth@claimflow.test', name: 'oth', role: 'employee' as never, managerId: 'mgr', passwordHash: 'x' }] });
  const claims = Array.from({ length: 10_000 }, (_, i) => ({ id: `bulk${i}`, claimantId: i % 2 ? 'oth' : 'emp', title: 't', purpose: 'p'.repeat(10), status: 'submitted' as const, createdAt: new Date(0), updatedAt: new Date(0), submittedAt: new Date(i) }));
  for (let i = 0; i < claims.length; i += 2000) await prisma.claim.createMany({ data: claims.slice(i, i + 2000) });
  const lines = claims.flatMap((c, i) => mkLines(3, c.id, i));
  for (let i = 0; i < lines.length; i += 3000) await prisma.claimLine.createMany({ data: lines.slice(i, i + 3000) });
  await prisma.claim.createMany({ data: [{ id: 'big', claimantId: 'emp', title: 't', purpose: 'p'.repeat(10), status: 'draft', createdAt: new Date(0), updatedAt: new Date(0) }] });
  const big = Array.from({ length: 50 }, (_, p) => ({ id: `bl${p}`, claimId: 'big', position: p + 1, date: '2025-12-15', categoryCode: 'meals', amountCents: 10 + p, description: 'x' }));
  await prisma.claimLine.createMany({ data: big });
  await prisma.receipt.createMany({ data: big.flatMap((l) => Array.from({ length: 5 }, (_, k) => ({ id: `${l.id}r${k}`, lineId: l.id, claimId: 'big', uploadedById: 'emp', uploadedAt: new Date(0), storageKey: `${l.id}r${k}`, sha256: `${l.id}r${k}`, sizeBytes: 1, mime: 'image/png' }))) });

  // Query count: instrument the transaction client, 1 line vs 50 lines.
  const dl = (n: number) => big.slice(0, n).map((l) => ({ ...l, shas: [`${l.id}r0`] }));
  for (const n of [1, 50]) {
    const calls = { receipt: 0, raw: 0 };
    await withWrite(prisma, async (tx) => {
      const spy = new Proxy(tx, { get: (t, k) => k === 'receipt' ? new Proxy(t.receipt, { get: (r, m) => { if (m === 'findMany') calls.receipt++; return (r as any)[m]; } }) : k === '$queryRaw' ? (...a: unknown[]) => { calls.raw++; return (t.$queryRaw as any)(...a); } : (t as any)[k] });
      await findDuplicates(spy as never, { id: 'big', claimantId: 'emp' }, dl(n));
    });
    assert.deepEqual(calls, { receipt: 1, raw: 1 }, `${n} lines`);
  }

  // Index use.
  const plan = (await prisma.$queryRaw<{ detail: string }[]>(Prisma.sql`EXPLAIN QUERY PLAN SELECT l."claimId" FROM "ClaimLine" l JOIN "Claim" c ON c."id" = l."claimId" WHERE c."claimantId" = 'emp' AND c."status" <> 'draft' AND c."id" <> 'big' AND ((l."date" = '2025-12-15' AND l."categoryCode" = 'meals' AND l."amountCents" = 10) OR (l."date" = '2025-12-16' AND l."categoryCode" = 'meals' AND l."amountCents" = 11))`)).map((r) => r.detail).join('\n');
  assert.match(plan, /ClaimLine_date_categoryCode_amountCents_idx/);
  const rplan = (await prisma.$queryRaw<{ detail: string }[]>(Prisma.sql`EXPLAIN QUERY PLAN SELECT "claimId" FROM "Receipt" WHERE "sha256" IN ('a','b')`)).map((r) => r.detail).join('\n');
  assert.match(rplan, /Receipt_sha256_idx/);

  // p95 over 20 real submits (each reset to draft first).
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    await prisma.claim.update({ where: { id: 'big' }, data: { status: 'draft', submittedAt: null, approverId: null } });
    const t0 = performance.now();
    await submitClaim(deps, { id: 'emp', role: 'employee' }, 'big');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[18] < 1000, `p95 ${times[18]}ms`);
});
