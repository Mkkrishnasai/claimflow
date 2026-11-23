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

before(async () => {
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  const u = (id: string, role: 'admin' | 'employee' | 'manager' | 'finance', extra = {}) =>
    ({ id, email: `${id}@claimflow.test`, name: id, role, passwordHash, ...extra });
  await prisma.user.createMany({ data: [
    u('admin', 'admin'), u('emp', 'employee'), u('mgr', 'manager'), u('fin', 'finance'),
    u('inactive', 'manager', { active: false }),
    u('A', 'manager'), u('B', 'manager', { managerId: 'A' }),
    u('c1', 'manager'), u('c2', 'manager', { managerId: 'c1' }), u('c3', 'manager', { managerId: 'c2' }),
    u('c4', 'manager', { managerId: 'c3' }), u('c5', 'manager', { managerId: 'c4' }),
    u('X', 'manager'), u('Y', 'manager'), u('Z', 'manager'),
  ] });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });

async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }),
  });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
type S = { cookie: string; csrf: string };
const patch = (s: S | null, id: string, managerId: unknown, csrf: string | null = s?.csrf ?? null) =>
  fetch(`${base}/api/users/${id}/manager`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) } : {}) },
    body: JSON.stringify({ managerId }),
  });
const mgrOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).managerId;
const violation = async (r: Response) => {
  assert.equal(r.status, 409);
  const j = (await r.json()) as { error: string; reason: string };
  assert.equal(j.error, 'hierarchy_violation');
  assert.ok(j.reason);
};

test('AC-1 401 / 403 forbidden / 403 csrf, no row changes', async () => {
  assert.equal((await patch(null, 'B', 'mgr')).status, 401);
  for (const id of ['emp', 'mgr', 'fin']) {
    const r = await patch(await signIn(id), 'B', 'mgr');
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  const a = await signIn('admin');
  for (const csrf of [null, 'wrong']) {
    const r = await patch(a, 'B', 'mgr', csrf);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'csrf' });
  }
  assert.equal(await mgrOf('B'), 'A');
});

test('AC-2 self, 2-user loop and 5-level loop refused; no loops remain', async () => {
  const a = await signIn('admin');
  await violation(await patch(a, 'A', 'A'));
  await violation(await patch(a, 'A', 'B'));
  await violation(await patch(a, 'c1', 'c5'));
  assert.equal(await mgrOf('A'), null);
  assert.equal(await mgrOf('B'), 'A');
  assert.equal(await mgrOf('c1'), null);
  // forest check: every walk terminates
  const all = await prisma.user.findMany();
  const parent = new Map(all.map((u) => [u.id, u.managerId]));
  for (const u of all) {
    const seen = new Set<string>();
    for (let c: string | null | undefined = u.id; c; c = parent.get(c)) {
      assert.ok(!seen.has(c), `loop at ${c}`);
      seen.add(c);
    }
  }
});

test('AC-3 unknown / inactive / non-manager refused; null clears', async () => {
  const a = await signIn('admin');
  for (const m of ['ghost', 'inactive', 'emp']) await violation(await patch(a, 'B', m));
  assert.equal(await mgrOf('B'), 'A');
  const r = await patch(a, 'B', null);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { managerId: unknown }).managerId, null);
  assert.equal(await mgrOf('B'), null);
});

test('AC-4 concurrent updates forming a loop: one 200, one 409', async () => {
  const a = await signIn('admin');
  assert.equal((await patch(a, 'Y', 'X')).status, 200);
  const rs = await Promise.all([patch(a, 'X', 'Z'), patch(a, 'Z', 'Y')]);
  // X->Z and Z->Y with Y->X would loop only if both succeed
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
});
