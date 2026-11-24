import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';

const PW = 'correct horse battery';
const queries: string[] = [];
const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
(prisma as unknown as { $on: (e: string, f: (q: { query: string }) => void) => void }).$on('query', (q) => { queries.push(q.query); });
let srv: Server, base: string;
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del']; // paid claims and history are undeletable by trigger
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};

before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: [{ id: 'emp', role: 'employee' as const }, { id: 'fin', role: 'finance' as const }].map((u) => ({ ...u, email: `${u.id}@claimflow.test`, name: u.id, passwordHash })) });
  const now = Date.now();
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    id: `c${i}`, claimantId: 'emp', title: `t${i}`, purpose: 'purpose text', status: (i < 2000 ? 'ready_to_pay' : 'submitted') as 'ready_to_pay', createdAt: new Date(now), updatedAt: new Date(now + i), submittedAt: new Date(now + i),
  }));
  for (let i = 0; i < rows.length; i += 1000) await prisma.claim.createMany({ data: rows.slice(i, i + 1000) });
  // One 1,000,000-cent line per queue claim: 2,000 x 1e6 = 2e9, then one more line pushes the sum past 2^31.
  const lines = rows.slice(0, 2000).map((c, i) => ({ id: `l${i}`, claimId: c.id, position: 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 1_000_000, description: 'x' }));
  lines.push({ id: 'lx', claimId: 'c0', position: 2, date: '2026-03-01', categoryCode: 'meals', amountCents: 200_000_000, description: 'x' });
  for (let i = 0; i < lines.length; i += 1000) await prisma.claimLine.createMany({ data: lines.slice(i, i + 1000) });
  // Pay requires approval history; c1..c20 are the claims the pay test uses.
  await prisma.claimEvent.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ claimId: `c${i + 1}`, actorId: 'emp', action: 'approve_final', fromStatus: 'submitted', toStatus: 'ready_to_pay', seq: 1, at: new Date() })) });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

test('NFR-PERF-1 GET /api/payments default page p95 under 1000 ms over 20 runs; totals above 2^31 exact', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'fin@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/payments`, { headers: { cookie } });
    const j = (await res.json()) as { count: number; totalCents: number; items: unknown[] };
    assert.equal(res.status, 200);
    assert.equal(j.items.length, 50); assert.equal(j.count, 2000);
    assert.equal(j.totalCents, 2_200_000_000); assert.ok(j.totalCents > 2 ** 31);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 1000);
});

test('NFR-PERF-1 POST /api/claims/:id/pay p95 under 500 ms over 20 distinct claims', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'fin@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const times: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/claims/c${i}/pay`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ paymentDate: '2026-01-15', reference: `INV-${i}` }) });
    assert.equal(res.status, 200);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 500);
});

test('NFR-PERF-1 POST /api/claims/:id/send-back p95 under 500 ms over 20 distinct claims', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'fin@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const times: number[] = [];
  for (let i = 21; i <= 40; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/claims/c${i}/send-back`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Receipt unreadable' }) });
    assert.equal(res.status, 200);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 500);
});

test('NFR-PERF-2 GET /api/exports/paid-claims.csv 10,000 paid claims (30,000 lines): p95 under 5 s over 5 runs, at most 3 claim queries', async () => {
  await prisma.claimLine.deleteMany({ where: { claimId: { startsWith: 'p' } } });
  const ids = Array.from({ length: 10_000 }, (_, i) => `p${String(i).padStart(5, '0')}`);
  for (let i = 0; i < ids.length; i += 1000) await prisma.claim.createMany({ data: ids.slice(i, i + 1000).map((id) => ({ id, claimantId: 'emp', title: 't', purpose: 'purpose text', status: 'draft' as const, createdAt: new Date(), updatedAt: new Date() })) });
  const lines = ids.flatMap((id) => [1, 2, 3].map((position) => ({ claimId: id, position, date: '2026-03-01', categoryCode: 'meals', amountCents: 1000, description: 'x' })));
  for (let i = 0; i < lines.length; i += 3000) await prisma.claimLine.createMany({ data: lines.slice(i, i + 3000) });
  await prisma.claim.updateMany({ where: { id: { startsWith: 'p' } }, data: { status: 'paid', paymentDate: '2026-03-10', paymentReference: 'INV-1' } });
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'fin@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    queries.length = 0;
    const t = performance.now();
    const res = await fetch(`${base}/api/exports/paid-claims.csv?from=2026-03-01&to=2026-03-31`, { headers: { cookie } });
    const csv = await res.text();
    times.push(performance.now() - t);
    assert.equal(res.status, 200);
    assert.equal(csv.split('\r\n').filter(Boolean).length, 30_001);
    assert.ok(queries.filter((q) => /"Claim(Line|Event)?"/.test(q)).length <= 3);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 5000);
});
