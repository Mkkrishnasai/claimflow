import { test, before, after, beforeEach } from 'node:test';
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
let tick = 0;
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
const seed = async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'mgr', 'fin', 'adm'].map((id) => ({ id, email: `${id}@claimflow.test`, name: `N-${id}`, role: ({ emp: 'employee', mgr: 'manager', fin: 'finance', adm: 'admin' } as const)[id as 'emp'], passwordHash })) });
};
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }),
  });
  return r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
}
const get = (cookie: string | null, q = '') => fetch(`${base}/api/payments${q}`, { headers: cookie ? { cookie } : {} });
type J = Record<string, any>;

// Lines are created before the status moves: a paid claim refuses inserts.
const mk = async (status: string, amounts: number[] = [1000], line: Record<string, unknown> = {}) => {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const c = await prisma.claim.create({ data: { claimantId: 'emp', title: `t${tick}`, purpose: 'purpose text', status: 'draft', createdAt: at, updatedAt: at, submittedAt: at, lines: { create: amounts.map((a, i) => ({ position: i + 1, date: '2026-03-01', categoryCode: 'meals', amountCents: a, description: 'x', limitCents: 5000, ...line })) } } });
  if (status === 'draft') return c;
  return prisma.claim.update({ where: { id: c.id }, data: { status: status as never, updatedAt: at, ...(status === 'paid' ? { paymentDate: '2026-11-24', paymentReference: 'INV-1' } : {}) } });
};

test('AC-1 finance sees ready_to_pay claims with totals, ordered by updatedAt then id', async () => {
  const a = await mk('ready_to_pay', [12_500]); const b = await mk('ready_to_pay', [5000, 2500]);
  const r = await get(await signIn('fin'));
  assert.equal(r.status, 200);
  const j = (await r.json()) as J;
  assert.equal(j.count, 2); assert.equal(j.totalCents, 20_000);
  assert.deepEqual(j.items.map((i: J) => i.id), [a.id, b.id]);
  assert.deepEqual(Object.keys(j.items[1]).sort(), ['claimant', 'duplicateCount', 'id', 'lineCount', 'overLimitCount', 'readyAt', 'submittedAt', 'title', 'totalCents']);
  assert.deepEqual(j.items[1].claimant, { id: 'emp', name: 'N-emp' });
  assert.equal(j.items[1].totalCents, 7500); assert.equal(j.items[1].lineCount, 2);
});

test('AC-2 only ready_to_pay listed; employee, manager, admin 403; anonymous 401', async () => {
  for (const s of ['draft', 'submitted', 'approved', 'rejected', 'paid']) await mk(s);
  const q = await mk('ready_to_pay');
  const j = (await (await get(await signIn('fin'))).json()) as J;
  assert.deepEqual(j.items.map((i: J) => i.id), [q.id]);
  for (const id of ['emp', 'mgr', 'adm']) {
    const r = await get(await signIn(id));
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal((await get(null)).status, 401);
});

test('AC-3 a paid claim leaves the queue and the totals drop', async () => {
  const a = await mk('ready_to_pay', [1000]); await mk('ready_to_pay', [2000]);
  const fin = await signIn('fin');
  assert.equal(((await (await get(fin)).json()) as J).count, 2);
  await prisma.claim.update({ where: { id: a.id }, data: { status: 'paid', paymentDate: '2026-11-24', paymentReference: 'INV-1' } });
  const j = (await (await get(fin)).json()) as J;
  assert.equal(j.count, 1); assert.equal(j.totalCents, 2000);
});

test('AC-4 limit pages items but not totals; bad paging 422; non-finance 403 first', async () => {
  for (let i = 1; i <= 3; i++) await mk('ready_to_pay', [i * 100]);
  const fin = await signIn('fin');
  const j = (await (await get(fin, '?limit=1')).json()) as J;
  assert.equal(j.items.length, 1); assert.equal(j.count, 3); assert.equal(j.totalCents, 600);
  for (const q of ['?limit=0', '?offset=-1']) {
    const r = await get(fin, q);
    assert.equal(r.status, 422); assert.equal(((await r.json()) as J).error, 'invalid_input');
  }
  assert.equal((await get(await signIn('emp'), '?limit=0')).status, 403);
});

test('AC-5 over-limit and duplicate flags counted; empty queue is zero', async () => {
  const fin = await signIn('fin');
  assert.deepEqual(await (await get(fin)).json(), { count: 0, totalCents: 0, items: [] });
  const over = await mk('ready_to_pay', [5001]);
  const dup = await mk('ready_to_pay', [1000], { duplicateClaimId: over.id, duplicateBasis: 'receipt' });
  const j = (await (await get(fin)).json()) as J;
  const by = (id: string) => j.items.find((i: J) => i.id === id);
  assert.equal(by(over.id).overLimitCount, 1); assert.equal(by(over.id).duplicateCount, 0);
  assert.equal(by(dup.id).duplicateCount, 1); assert.equal(by(dup.id).overLimitCount, 0);
});
