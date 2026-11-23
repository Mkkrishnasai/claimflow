import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { claimTestRouteDefs } from '../../api/src/test-routes.js';
import { claimRouteDefs } from '../../api/src/claims/routes.js';
import { userRouteDefs } from '../../api/src/users/routes.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, srv2: Server, base: string, base2: string;
type S = { cookie: string; csrf: string };
const sessions: Record<string, S> = {};
const ROLES = ['employee', 'manager', 'finance', 'admin'] as const;
const listen = async (testRoutes: boolean) => {
  const s = createApp({ testRoutes, log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`] as const;
};

async function signIn(email: string): Promise<S> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email, password: PW }),
  });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
const call = (s: S | null, method: string, path: string, body?: unknown, csrf: string | null = s?.csrf ?? null, b = base) =>
  fetch(`${b}${path}`, { method, headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

// Requesters: emp (E), mgr (M, manager of d1 and of m1), fin (F), adm (A).
// d1 -> M (depth 1); d2 -> m1 -> M (depth 2); d3 -> m2 -> m1 -> M (depth 3); M -> U (upward); ob -> OB (other branch); un (unrelated).
const POS: Record<string, string> = { own: 'mgr', d1: 'd1', d2: 'd2', d3: 'd3', upward: 'U', other: 'ob', unrelated: 'un' };

before(async () => {
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany();
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  const u = (id: string, role: string, extra = {}) => ({ id, email: `${id}@claimflow.test`, name: `N-${id}`, role: role as never, passwordHash, ...extra });
  await prisma.user.createMany({ data: [
    u('adm', 'admin'), u('emp', 'employee'), u('fin', 'finance'), u('U', 'manager'), u('OB', 'manager'),
    u('mgr', 'manager', { managerId: 'U' }), u('m1', 'manager', { managerId: 'mgr' }), u('m2', 'manager', { managerId: 'm1' }),
    u('d1', 'employee', { managerId: 'mgr' }), u('d2', 'employee', { managerId: 'm1' }), u('d3', 'employee', { managerId: 'm2' }),
    u('ob', 'employee', { managerId: 'OB' }), u('un', 'employee'),
  ] });
  [srv, base] = await listen(true);
  [srv2, base2] = await listen(false);
  for (const id of ['adm', 'emp', 'mgr', 'fin']) sessions[id] = await signIn(`${id}@claimflow.test`);
});
after(async () => {
  srv.close(); srv2.close();
  await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany(); await prisma.$disconnect();
});

const ROLE_USER = { employee: 'emp', manager: 'mgr', finance: 'fin', admin: 'adm' } as const;

const ALL_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'ready_to_pay', 'paid'];

// Same cells for the fixture route and the production route; `mk` creates a claim and returns its id.
// `paid` rows are undeletable by trigger, so the DB-backed run skips it (canReadClaim treats it like approved; the fixture run covers it).
async function matrix(mk: (claimantId: string, status: string) => Promise<string>, path: (id: string) => string, STATUSES6 = ALL_STATUSES) {
  const ids: Record<string, string> = {};
  for (const [cell, claimant] of Object.entries(POS)) for (const status of STATUSES6) ids[`${cell}/${status}`] = await mk(claimant, status);
  for (const rid of ['emp', 'fin', 'adm']) for (const status of STATUSES6) ids[`own-${rid}/${status}`] = await mk(rid, status);
  let n = 0;
  for (const role of ROLES) {
    const s = sessions[ROLE_USER[role]];
    const expect = (cell: string, status: string): number => {
      if (cell === 'own') return 200;
      if (role === 'manager') return cell === 'd1' || cell === 'd2' ? 200 : 403;
      if (role === 'finance') return status !== 'draft' ? 200 : 403;
      return 403;
    };
    for (const cell of Object.keys(POS)) for (const status of STATUSES6) {
      const id = cell === 'own' && role !== 'manager' ? ids[`own-${ROLE_USER[role]}/${status}`] : ids[`${cell}/${status}`];
      const r = await call(s, 'GET', path(id));
      assert.equal(r.status, expect(cell, status), `${role} ${cell} ${status}`);
      if (r.status === 403) assert.deepEqual(await r.json(), { error: 'forbidden' });
      n++;
    }
  }
  assert.equal(n, 4 * 7 * STATUSES6.length);
}

test('AC-1 claim read matrix (fixture route): 4 roles x positions x 6 statuses, 0 deviations', async () => {
  await call(sessions.adm, 'POST', '/__test/fixtures/reset');
  await matrix(async (claimantId, status) => {
    const r = await call(sessions.adm, 'POST', '/__test/fixtures/claims', { claimantId, status });
    assert.equal(r.status, 201);
    return ((await r.json()) as { id: string }).id;
  }, (id) => `/__test/claims/${id}`);
});

const mkDb = async (claimantId: string, status: string) => {
  const now = new Date();
  return (await prisma.claim.create({ data: { claimantId, title: 't', purpose: 'purpose text', status: status as never, createdAt: now, updatedAt: now } })).id;
};

test('AC-1b claim read matrix (GET /api/claims/:id): same cells (paid excluded), 0 deviations', async () => {
  await matrix(mkDb, (id) => `/api/claims/${id}`, ALL_STATUSES.filter((x) => x !== 'paid'));
});

test('GET /api/claims/:id: unknown id 404 for authenticated, 401 without session', async () => {
  const r = await call(sessions.emp, 'GET', '/api/claims/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not_found' });
  assert.equal((await call(null, 'GET', '/api/claims/nope')).status, 401);
});

test('AC-4 manager change takes effect on the very next request (no cached grant)', async () => {
  const id = await mkDb('d1', 'submitted'); // d1 -> mgr
  assert.equal((await call(sessions.mgr, 'GET', `/api/claims/${id}`)).status, 200);
  await prisma.user.update({ where: { id: 'd1' }, data: { managerId: 'OB' } });
  try {
    assert.equal((await call(sessions.mgr, 'GET', `/api/claims/${id}`)).status, 403);
  } finally { await prisma.user.update({ where: { id: 'd1' }, data: { managerId: 'mgr' } }); }
});

test('AC-2 user-data routes, shapes, 403 vs 404', async () => {
  const exp = { employee: [403, 200, 403], manager: [403, 200, 403], finance: [403, 200, 403], admin: [200, 200, 200] };
  for (const role of ROLES) {
    const id = ROLE_USER[role];
    const got = [
      (await call(sessions[id], 'GET', '/api/users')).status,
      (await call(sessions[id], 'GET', `/api/users/${id}`)).status,
      (await call(sessions[id], 'GET', `/api/users/${id === 'emp' ? 'mgr' : 'emp'}`)).status,
    ];
    assert.deepEqual(got, exp[role], role);
    assert.equal((await call(sessions[id], 'GET', '/api/users/ghost')).status, role === 'admin' ? 404 : 403);
  }
  const list = (await (await call(sessions.adm, 'GET', '/api/users')).json()) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(list[0]).sort(), ['active', 'email', 'id', 'managerId', 'managerInactive', 'managerName', 'name', 'role']);
  const names = list.map((x) => x.name as string);
  assert.deepEqual(names, [...names].sort());
  const d = (await (await call(sessions.adm, 'GET', '/api/users/mgr')).json()) as Record<string, unknown>;
  assert.deepEqual(d.reports, [{ id: 'm1', name: 'N-m1' }, { id: 'd1', name: 'N-d1' }].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(d.managerName, 'N-U');
  assert.equal(d.lockedUntil, null);
  assert.equal(d.passwordSet, true);
});

const fill = (p: string) => p.replace(':id', 'x');
const defs = () => [...userRouteDefs({} as never), ...claimTestRouteDefs({} as never), ...claimRouteDefs({} as never)].filter((d) => d.data !== 'none' || d.write);

test('AC-3 every route: 401 without session, 403 csrf on writes with bad token', async () => {
  const before = await prisma.user.count();
  for (const d of defs()) {
    const path = (d.path.startsWith('/__test') ? '' : '/api') + fill(d.path);
    const m = d.method.toUpperCase();
    assert.equal((await call(null, m, path, d.write ? {} : undefined)).status, 401, `${m} ${path}`);
    if (!d.write) continue;
    for (const csrf of [null, 'wrong']) {
      const r = await call(sessions.adm, m, path, {}, csrf);
      assert.equal(r.status, 403, `${m} ${path}`);
      assert.deepEqual(await r.json(), { error: 'csrf' });
    }
  }
  assert.equal(await prisma.user.count(), before);
});

test('AC-4 deactivated user 401, missing claim 404, /__test absent when not test mode', async () => {
  const s = await signIn('d1@claimflow.test');
  assert.equal((await call(s, 'GET', '/api/users/d1')).status, 200);
  await prisma.user.update({ where: { id: 'd1' }, data: { active: false } });
  for (const [m, p] of [['GET', '/api/users/d1'], ['GET', '/api/users'], ['GET', '/__test/claims/x']]) assert.equal((await call(s, m, p)).status, 401);
  await prisma.user.update({ where: { id: 'd1' }, data: { active: true } });
  assert.equal((await call(sessions.emp, 'GET', '/__test/claims/nope')).status, 404);
  for (const [m, p] of [['POST', '/__test/fixtures/claims'], ['POST', '/__test/fixtures/reset'], ['GET', '/__test/claims/x']])
    assert.equal((await call(sessions.adm, m, p, m === 'POST' ? {} : undefined, null, base2)).status, 404);
});
