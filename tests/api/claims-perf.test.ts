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
  await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
};

before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'other'].map((id) => ({ id, email: `${id}@claimflow.test`, name: id, role: 'employee' as const, passwordHash })).concat([{ id: 'apr', email: 'apr@claimflow.test', name: 'apr', role: 'employee' as const, passwordHash }]) });
  const now = new Date();
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    id: `c${i}`, claimantId: i < 100 ? 'emp' : 'other', title: `t${i}`, purpose: 'purpose text', status: 'submitted' as const, approverId: i % 2 ? 'apr' : null, submittedAt: new Date(now.getTime() + i), createdAt: now, updatedAt: new Date(now.getTime() + i),
  }));
  for (let i = 0; i < rows.length; i += 1000) await prisma.claim.createMany({ data: rows.slice(i, i + 1000) });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

test('AC-5 p95 under 1000 ms over 200 alternating reads at 10,000 claims', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'emp@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/claims${i % 2 ? `/c${i % 100}` : ''}`, { headers: { cookie } });
    await res.text();
    assert.equal(res.status, 200);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 1000);
});

test('NFR-PERF-1 GET /api/approvals default page p95 under 1000 ms over 20 runs at 10,000 claims', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: 'apr@claimflow.test', password: PW }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const res = await fetch(`${base}/api/approvals`, { headers: { cookie } });
    const rows = (await res.json()) as { id: string }[];
    assert.equal(res.status, 200);
    assert.equal(rows.length, 50);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 1000);
  assert.equal((await fetch(`${base}/api/approvals?limit=0`, { headers: { cookie } })).status, 422);
});
