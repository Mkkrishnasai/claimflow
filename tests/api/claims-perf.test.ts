import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
const wipe = async () => {
  await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
};

before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'other'].map((id) => ({ id, email: `${id}@claimflow.test`, name: id, role: 'employee' as const, passwordHash })).concat([{ id: 'apr', email: 'apr@claimflow.test', name: 'apr', role: 'employee' as const, passwordHash }]) });
  const now = new Date();
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    id: `c${i}`, claimantId: i < 1000 ? 'emp' : 'other', title: `t${i}`, purpose: 'purpose text', status: 'submitted' as const, approverId: i % 2 ? 'apr' : null, submittedAt: new Date(now.getTime() + i), createdAt: now, updatedAt: new Date(now.getTime() + i),
  }));
  for (let i = 0; i < rows.length; i += 1000) await prisma.claim.createMany({ data: rows.slice(i, i + 1000) });
  const lines = rows.flatMap((c) => [1, 2].map((position) => ({ id: `${c.id}l${position}`, claimId: c.id, position, date: '2026-03-01', categoryCode: 'meals', amountCents: 1000, description: 'x' })));
  for (let i = 0; i < lines.length; i += 1000) await prisma.claimLine.createMany({ data: lines.slice(i, i + 1000) });
  const receipts = lines.map((l) => ({ lineId: l.id, claimId: l.claimId, storageKey: `k-${l.id}`, sha256: 'a'.repeat(64), sizeBytes: 10, mime: 'image/png', uploadedById: 'emp', uploadedAt: now }));
  for (let i = 0; i < receipts.length; i += 1000) await prisma.receipt.createMany({ data: receipts.slice(i, i + 1000) });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

const signIn = async (email: string) => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email, password: PW }),
  });
  return r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
};

// Warm-up, then n timed calls; every response must be 200 with 50 rows. Returns p95.
async function p95(cookie: string, paths: string[], check?: (rows: any[]) => void) {
  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    const rows = (await res.json()) as any[];
    assert.equal(res.status, 200); assert.equal(rows.length, 50);
    check?.(rows);
  };
  await call(paths[0]);
  const times: number[] = [];
  for (const path of paths) { const t = performance.now(); await call(path); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length * 0.95)];
}

test('AC-1 GET /api/claims p95 under 1000 ms over 100 alternating pages at 10,000 claims', async () => {
  const v = await p95(await signIn('emp@claimflow.test'), Array.from({ length: 100 }, (_, i) => `/api/claims?limit=50${i % 2 ? '&offset=950' : ''}`));
  assert.ok(v < 1000, `p95 ${v.toFixed(1)} ms`);
});

test('AC-2 GET /api/approvals p95 under 1000 ms over 20 runs at 10,000 claims', async () => {
  const cookie = await signIn('apr@claimflow.test');
  const v = await p95(cookie, Array(20).fill('/api/approvals'), (rows) => { for (const r of rows) assert.ok(r.lines.every((l: any) => l.receipts.length > 0)); });
  assert.ok(v < 1000, `p95 ${v.toFixed(1)} ms`);
  assert.equal((await fetch(`${base}/api/approvals?limit=0`, { headers: { cookie } })).status, 422);
});
