import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { withWrite } from '../../api/src/db.js';
import { receiptForRead } from '../../api/src/claims/service.js';
import { prismaClaimStore } from '../../api/src/claims/store.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
const out: string[] = [];
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function seed() {
  await wipe();
  const hash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, managerId: string | null = null) => ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, active: true, passwordHash: hash });
  await prisma.user.createMany({ data: [u('adm', 'admin'), u('top', 'manager'), u('m', 'manager', 'top'), u('orphan', 'manager'), u('emp', 'employee', 'm')] });
  out.length = 0;
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock: () => new Date(), mailer: { async linkMail() {}, async reassignedMail() {} } as never, publicBaseUrl: 'http://app.test', claims: prismaClaimStore } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }) });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
let n = 0;
const mk = (approverId: string | null, status: string) =>
  prisma.claim.create({ data: { id: `c${++n}`, claimantId: 'emp', title: 't', purpose: 'p', status: status as never, approverId, createdAt: new Date(0), updatedAt: new Date(0) } });
const deact = async (id: string) => { const s = await signIn('adm'); return fetch(`${base}/api/users/${id}/deactivate`, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } }); };

test('AC-1 3 submitted claims move up with 3 reassigned rows by the admin; log carries 3', async () => {
  const cs = [await mk('m', 'submitted'), await mk('m', 'submitted'), await mk('m', 'submitted')];
  const r = await deact('m');
  assert.equal(r.status, 200);
  for (const c of cs) {
    const row = await prisma.claim.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(row.approverId, 'top'); assert.equal(row.status, 'submitted');
    const ev = await prisma.claimEvent.findMany({ where: { claimId: c.id } });
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].action, ev[0].fromStatus, ev[0].toStatus, ev[0].actorId], ['reassigned', 'submitted', 'submitted', 'adm']);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.map((l) => JSON.parse(l)).some((l) => l.path === '/api/users/m/deactivate' && l.reassignedClaims === 3));
});

test('AC-2 stranding refused 409 with 0 claims and 0 history rows changed', async () => {
  await mk('orphan', 'submitted'); await mk('orphan', 'submitted');
  const r = await deact('orphan');
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'would_strand_claims');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: 'orphan' } })).active, true);
  assert.equal(await prisma.claim.count({ where: { approverId: 'orphan' } }), 2);
  assert.equal(await prisma.claimEvent.count(), 0);
});

test('AC-3 listWaitingOn returns submitted and approved claims for that approver', async () => {
  const a = await mk('m', 'submitted');
  const b = await mk('m', 'approved'); await mk('m', 'draft'); await mk('top', 'submitted');
  const got = await withWrite(prisma, (tx) => prismaClaimStore.listWaitingOn(tx, 'm'));
  assert.deepEqual(got.map((c) => c.id), [a.id, b.id]);
  assert.equal(await withWrite(prisma, (tx) => prismaClaimStore.get(tx, 'nope')), null);
});

test('AC-3 server.ts wires prismaClaimStore', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../../api/src/server.ts', import.meta.url), 'utf8'), /claims: prismaClaimStore/);
});

test('failure after reassign rolls back claims and history together', async () => {
  await mk('m', 'submitted');
  await assert.rejects(withWrite(prisma, async (tx) => { await prismaClaimStore.reassign(tx, ['c' + n], 'top', 'adm'); throw new Error('boom'); }));
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: `c${n}` } })).approverId, 'm');
  assert.equal(await prisma.claimEvent.count(), 0);
});

test('approved claim moves up with reassigned approved -> approved', async () => {
  const c = await mk('m', 'approved');
  assert.equal((await deact('m')).status, 200);
  const row = await prisma.claim.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([row.approverId, row.status], ['top', 'approved']);
  const ev = await prisma.claimEvent.findMany({ where: { claimId: c.id } });
  assert.deepEqual(ev.map((e) => [e.action, e.fromStatus, e.toStatus]), [['reassigned', 'approved', 'approved']]);
});

test('approved claim with no manager above: 409 would_strand_claims, nothing changes', async () => {
  const c = await mk('orphan', 'approved');
  const r = await deact('orphan');
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'would_strand_claims');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: 'orphan' } })).active, true);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).approverId, 'orphan');
  assert.equal(await prisma.claimEvent.count(), 0);
});

test('GET claim and receipt: current approver 3 levels up reads (200), unrelated manager 403; claimant {id,name}', async () => {
  await prisma.user.createMany({ data: [{ id: 'stranger', email: 'stranger@claimflow.test', name: 'stranger', role: 'manager', managerId: null, active: true, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { id: 'top' } })).passwordHash }] });
  const c = await mk('stranger', 'submitted');
  await prisma.claimLine.create({ data: { id: `l${c.id}`, claimId: c.id, position: 1, date: '2026-01-01', categoryCode: (await prisma.category.findFirstOrThrow()).code, amountCents: 100, description: 'd' } });
  await prisma.receipt.create({ data: { id: `r${c.id}`, claimId: c.id, lineId: `l${c.id}`, storageKey: 'k', mime: 'application/pdf', sizeBytes: 1, sha256: 'x', uploadedById: 'emp', uploadedAt: new Date(0) } });
  const get = async (who: string, path: string) => { const s = await signIn(who); return fetch(`${base}${path}`, { headers: { cookie: s.cookie } }); };
  const r1 = await get('stranger', `/api/claims/${c.id}`);
  assert.equal(r1.status, 200);
  assert.deepEqual(((await r1.json()) as { claimant: unknown }).claimant, { id: 'emp', name: 'emp' });
  const d = { prisma } as never;
  assert.equal((await receiptForRead(d, { id: 'stranger', role: 'manager' }, c.id, `r${c.id}`)).mime, 'application/pdf');
  assert.equal((await get('orphan', `/api/claims/${c.id}`)).status, 403);
  await assert.rejects(receiptForRead(d, { id: 'orphan', role: 'manager' }, c.id, `r${c.id}`), { status: 403 });
});
