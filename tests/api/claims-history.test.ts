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
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function seed() {
  await wipe();
  const hash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, managerId: string | null = null) => ({ id, email: `${id}@claimflow.test`, name: `Name ${id}`, role: role as never, managerId, active: true, passwordHash: hash });
  await prisma.user.createMany({ data: [u('mgr', 'manager'), u('emp', 'employee', 'mgr'), u('other', 'employee'), u('fin', 'finance')] });
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: () => {} }), deps: { prisma, clock, mailer: { async linkMail() {}, async reassignedMail() {} } as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

type S = { cookie: string; csrf: string };
async function signIn(id: string): Promise<S> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }) });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
const call = (s: S, method: string, path: string, body: unknown = {}) =>
  fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: method === 'GET' ? undefined : JSON.stringify(body) });

test('AC-1 submit, withdraw, submit: history in seq order with actor, readable only by allowed callers', async () => {
  const emp = await signIn('emp');
  await prisma.claim.create({ data: { id: 'h1', claimantId: 'emp', title: 'T', purpose: 'Some purpose text', status: 'draft', createdAt: new Date(0), updatedAt: new Date(0), lines: { create: [{ position: 1, date: '2025-12-25', categoryCode: 'meals', amountCents: 1000, description: 'x' }] } } });
  assert.equal((await call(emp, 'POST', '/claims/h1/submit')).status, 200);
  assert.equal((await call(emp, 'POST', '/claims/h1/withdraw', { reason: 'changed my mind' })).status, 200);
  assert.equal((await call(emp, 'POST', '/claims/h1/submit')).status, 200);

  const shape = (h: Record<string, unknown>[]) => h.map((e) => [e.seq, (e.actor as { id: string; name: string }), e.action, e.fromStatus, e.toStatus, e.reason]);
  const expected = [[1, { id: 'emp', name: 'Name emp' }, 'submit', 'draft', 'submitted', null], [2, { id: 'emp', name: 'Name emp' }, 'withdrawn', 'submitted', 'draft', 'changed my mind'], [3, { id: 'emp', name: 'Name emp' }, 'submit', 'draft', 'submitted', null]];
  for (const who of ['emp', 'mgr', 'fin']) {
    const r = await call(await signIn(who), 'GET', '/claims/h1');
    assert.equal(r.status, 200, who);
    const h = ((await r.json()) as { history: Record<string, unknown>[] }).history;
    assert.deepEqual(Object.keys(h[0]).sort(), ['action', 'actor', 'at', 'fromStatus', 'reason', 'seq', 'toStatus']);
    assert.ok(h.every((e) => typeof e.at === 'string'));
    assert.deepEqual(shape(h), expected, who);
  }
  const r = await call(await signIn('other'), 'GET', '/claims/h1');
  assert.equal(r.status, 403);
  assert.ok(!('history' in ((await r.json()) as object)));
});

test('AC-2 no PATCH/PUT/DELETE route on history', async () => {
  const { claimRouteDefs, receiptUploadDefs } = await import('../../api/src/claims/routes.js');
  const defs = [...claimRouteDefs({} as never), ...receiptUploadDefs({} as never)];
  assert.deepEqual(defs.filter((d) => d.method !== 'get' && d.method !== 'post' && /history|events/i.test(d.path)), []);
  const emp = await signIn('emp');
  for (const m of ['PATCH', 'PUT', 'DELETE']) for (const p of ['/claims/x/history', '/claims/x/history/1', '/claims/x/events']) assert.equal((await call(emp, m, p)).status, 404);
});
