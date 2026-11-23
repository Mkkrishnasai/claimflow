import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { FixtureClaimStore, type ClaimStore } from '../../api/src/claims-port.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
const store = new FixtureClaimStore();
let claims: ClaimStore = store;
const claimsProxy: ClaimStore = {
  get: (...a) => claims.get(...a),
  listWaitingOn: (...a) => claims.listWaitingOn(...a),
  reassign: (...a) => claims.reassign(...a),
};
let srv: Server, base: string, mailFail = false;
const sent: { to: string; claimId: string }[] = [];
const mailer = {
  async linkMail() {},
  async reassignedMail(to: string, claimId: string) { if (mailFail) throw new Error('down'); sent.push({ to, claimId }); },
};
const out: string[] = [];

async function seed() {
  const hash = await bcrypt.hash(PW, 4);
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  const u = (id: string, role: string, managerId: string | null = null, active = true) =>
    ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, active, passwordHash: hash });
  await prisma.user.createMany({ data: [
    u('a', 'admin'), u('top', 'manager'), u('gm', 'manager'), u('mi', 'manager', 'gm', false), u('chain', 'manager', 'mi'),
    u('m', 'manager', 'top'), u('r1', 'employee', 'top'), u('r2', 'employee', 'top'), u('emp', 'employee', 'm'),
    u('orphan', 'manager'), u('off', 'employee', null, false),
  ] });
  store.reset(); sent.length = 0; claims = store; mailFail = false; out.length = 0;
}

before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock: () => new Date(), mailer: mailer as never, publicBaseUrl: 'http://app.test', claims: claimsProxy } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => {
  srv.close();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany(); await prisma.$disconnect(); });

async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }),
  });
  const b = (await r.json()) as { csrfToken: string };
  return { status: r.status, cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))?.split(';')[0] ?? '', csrf: b.csrfToken };
}
type S = { cookie: string; csrf: string };
const deact = (id: string, s: S | null) =>
  fetch(`${base}/api/users/${id}/deactivate`, { method: 'POST', headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });
const active = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).active;
const waiting = (approverId: string, n: number, claimantId = 'emp') => { for (let i = 0; i < n; i++) store.add({ claimantId, approverId, status: 'submitted' }); };
const snapshot = async () => JSON.stringify([await prisma.user.findMany({ orderBy: { id: 'asc' } }), await prisma.session.count(), await store.listWaitingOn(null as never, 'm'), await store.listWaitingOn(null as never, 'top')]);

test('AC-1 moves 3 claims to the manager above, 3 mails, cannot sign in, own claims untouched', async () => {
  waiting('m', 3);
  const own = store.add({ claimantId: 'm', approverId: 'top', status: 'submitted' });
  const a = await signIn('a');
  const r = await deact('m', a);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'm', active: false, reassignedClaims: 3, notified: 3 });
  assert.equal((await store.listWaitingOn(null as never, 'top')).length, 4);
  assert.equal((await store.listWaitingOn(null as never, 'm')).length, 0);
  assert.deepEqual(await store.get(null as never, own.id), own);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.to === 'emp@claimflow.test'));
  assert.equal((await signIn('m')).status, 401);
});

test('AC-2 skips inactive manager to grandmanager; top-of-org with reports returns 200', async () => {
  waiting('chain', 2, 'emp');
  const a = await signIn('a');
  assert.equal((await deact('chain', a)).status, 200);
  assert.equal((await store.listWaitingOn(null as never, 'gm')).length, 2);
  assert.equal(sent.length, 2);
  assert.equal((await deact('top', a)).status, 200);
  assert.equal(await active('top'), false);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: 'r1' } })).managerId, 'top');
  assert.equal(sent.length, 2);
});

test('AC-3 refusals change nothing; 2 admins lets last-admin request succeed', async () => {
  waiting('orphan', 2);
  const a = await signIn('a');
  const before = await snapshot();
  const beforeOrphan = (await store.listWaitingOn(null as never, 'orphan')).length;
  let r = await deact('orphan', a);
  assert.equal(r.status, 409);
  const j = (await r.json()) as { error: string; reason: string };
  assert.equal(j.error, 'would_strand_claims');
  assert.ok(j.reason);
  assert.equal(await active('orphan'), true);
  assert.equal((await store.listWaitingOn(null as never, 'orphan')).length, beforeOrphan);
  r = await deact('a', a);
  assert.equal(r.status, 409);
  const l = (await r.json()) as { error: string; reason: string };
  assert.equal(l.error, 'last_admin');
  assert.match(l.reason, /last/);
  r = await deact('off', a);
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'already_inactive');
  assert.equal(await snapshot(), before);
  assert.equal(await prisma.session.count(), 1);
  await prisma.user.update({ where: { id: 'top' }, data: { role: 'admin' } });
  assert.equal((await deact('a', a)).status, 200);
});

test('AC-4 old session gets 401; non-admin 403, anonymous 401, nothing changes', async () => {
  const e = await signIn('emp');
  const a = await signIn('a');
  assert.equal((await deact('r1', null)).status, 401);
  assert.equal((await deact('r1', e)).status, 403);
  assert.equal(await active('r1'), true);
  assert.equal((await deact('emp', a)).status, 200);
  const r = await fetch(`${base}/api/users/emp`, { headers: { cookie: e.cookie } });
  assert.equal(r.status, 401);
});

test('AC-5 throwing stub at each step leaves everything intact', async () => {
  waiting('m', 3);
  const a = await signIn('a');
  await signIn('m');
  const before = await snapshot();
  const sessions = await prisma.session.count();
  for (const step of ['listWaitingOn', 'reassign'] as const) {
    claims = { ...store, get: store.get.bind(store), listWaitingOn: store.listWaitingOn.bind(store), reassign: store.reassign.bind(store), [step]: async () => { throw new Error('boom'); } };
    assert.equal((await deact('m', a)).status, 500);
    assert.equal(await snapshot(), before);
    assert.equal(await prisma.session.count(), sessions);
  }
  claims = store;
  assert.equal(sent.length, 0);
});

test('AC-5 mail failure does not roll back; success writes one log line without email', async () => {
  waiting('m', 3);
  const a = await signIn('a');
  mailFail = true;
  const r = await deact('m', a);
  assert.deepEqual(await r.json(), { id: 'm', active: false, reassignedClaims: 3, notified: 0 });
  assert.equal(await active('m'), false);
  await seed();
  waiting('m', 3);
  const a2 = await signIn('a');
  out.length = 0;
  assert.equal((await deact('m', a2)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const ls = out.map((l) => JSON.parse(l)).filter((l) => l.path === '/api/users/m/deactivate');
  assert.equal(ls.length, 1);
  assert.equal(ls[0].authEvent, 'deactivated');
  assert.equal(ls[0].reassignedClaims, 3);
  assert.ok(!out.join('').includes('@claimflow.test'));
});
