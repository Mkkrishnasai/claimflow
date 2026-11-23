import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { sha256 } from '../../api/src/auth/secrets.js';
import { createLogger } from '../../api/src/logger.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
const out: string[] = [];
let skew = 0;
let srv: Server, base: string;

before(async () => {
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: await bcrypt.hash(PW, 10) } });
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock: () => new Date(Date.now() + skew) } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });

async function signIn(email: string, password: string) {
  const c = await fetch(`${base}/api/auth/csrf`);
  const token = ((await c.json()) as { csrfToken: string }).csrfToken;
  return fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: c.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email, password }),
  });
}
const lines = () => out.map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setTimeout(r, 50));

test('AC-1 cost-10 hash upgraded to cost 12 on first sign-in, unchanged on second', async () => {
  const h = async () => (await prisma.user.findUniqueOrThrow({ where: { id: 'a' } })).passwordHash!;
  assert.match(await h(), /^\$2[aby]\$10\$/);
  assert.equal((await signIn('admin@claimflow.test', PW)).status, 200);
  const up = await h();
  assert.match(up, /^\$2[aby]\$12\$/);
  assert.equal((await signIn('admin@claimflow.test', PW)).status, 200);
  assert.equal(await h(), up);
});

// --- set-password (E-8) ---
const H = 3_600_000;
let n = 0;
async function issue(opts: { active?: boolean; ttl?: number } = {}) {
  const id = `u${++n}`, raw = `raw-token-${n}-${Math.random()}`;
  await prisma.user.create({ data: { id, email: `${id}@claimflow.test`, name: id, role: 'employee', active: opts.active ?? true } });
  await prisma.oneTimeToken.create({ data: { hash: sha256(raw), userId: id, purpose: 'set_password', expiresAt: new Date(Date.now() + (opts.ttl ?? 24 * H)) } });
  return { id, raw, email: `${id}@claimflow.test` };
}
async function setPw(token: string, password: string) {
  const c = await fetch(`${base}/api/auth/csrf`);
  const csrf = ((await c.json()) as { csrfToken: string }).csrfToken;
  return fetch(`${base}/api/auth/set-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: c.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ token, password }),
  });
}
const used = async (raw: string) => (await prisma.oneTimeToken.findUniqueOrThrow({ where: { hash: sha256(raw) } })).usedAt;
const NEW = 'a brand new password';

test('set-password without CSRF is 403', async () => {
  const t = await issue();
  const r = await fetch(`${base}/api/auth/set-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t.raw, password: NEW }) });
  assert.equal(r.status, 403);
  assert.equal(await used(t.raw), null);
});

test('set-password AC-1 first use ok with cost-12 hash, replay/unknown/malformed/expired all invalid_token', async () => {
  const t = await issue();
  const r = await setPw(t.raw, NEW);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.match((await prisma.user.findUniqueOrThrow({ where: { id: t.id } })).passwordHash!, /^\$2[aby]\$12\$/);
  const e = await issue({ ttl: 24 * H });
  skew = 24 * H + 1000;
  const late = await setPw(e.raw, NEW);
  skew = 0;
  for (const res of [await setPw(t.raw, NEW), await setPw('nope', NEW), await setPw(undefined as never, NEW), late]) {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_token' });
  }
  skew = 24 * H - 1000;
  const e2 = await issue();
  assert.equal((await setPw(e2.raw, NEW)).status, 200);
  skew = 0;
});

test('set-password AC-2 parallel replay yields exactly one 200', async () => {
  const t = await issue();
  const rs = await Promise.all([setPw(t.raw, NEW), setPw(t.raw, NEW)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
});

test('set-password AC-3 password rule, rejected password leaves token unused', async () => {
  const cases: [string, number, string?][] = [
    ['a'.repeat(11), 400, 'Password must be at least 12 characters'],
    ['a'.repeat(73), 400, 'Password must be at most 72 bytes'],
    ['é'.repeat(37), 400, 'Password must be at most 72 bytes'],
    ['a'.repeat(12), 200], ['a'.repeat(72), 200], ['é'.repeat(36), 200],
  ];
  for (const [pw, status, reason] of cases) {
    const t = await issue();
    const r = await setPw(t.raw, pw);
    assert.equal(r.status, status);
    if (reason) {
      assert.deepEqual(await r.json(), { error: 'invalid_password', reason });
      assert.equal(await used(t.raw), null);
    }
  }
});

test('set-password AC-4 deactivated user token refused, usedAt unset', async () => {
  const t = await issue({ active: false });
  const r = await setPw(t.raw, NEW);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid_token' });
  assert.equal(await used(t.raw), null);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: t.id } })).passwordHash, null);
});

test('set-password AC-5 ends existing sessions; new sign-in works', async () => {
  const t = await issue();
  await prisma.user.update({ where: { id: t.id }, data: { passwordHash: await bcrypt.hash(PW, 4) } });
  const si = await signIn(t.email, PW);
  assert.equal(si.status, 200);
  const cookie = si.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie } })).status, 200);
  assert.equal((await setPw(t.raw, NEW)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie } })).status, 401);
  assert.equal((await signIn(t.email, NEW)).status, 200);
});

test('set-password AC-6 DB stores only 64-hex hash; password and token absent from logs', async () => {
  const t = await issue();
  await setPw(t.raw, NEW);
  await settle();
  const row = await prisma.oneTimeToken.findFirstOrThrow({ where: { userId: t.id } });
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.hash, t.raw);
  const log = out.join('');
  assert.ok(!log.includes(t.raw) && !log.includes(NEW));
});
