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
let srv: Server, base: string, now = new Date('2026-01-01T00:00:00Z');
const clock = () => now;
const tick = (ms: number) => { now = new Date(now.getTime() + ms); };

before(async () => {
  const hash = await bcrypt.hash(PW, 12);
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.createMany({ data: [
    { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: hash },
    { id: 'd', email: 'off@claimflow.test', name: 'Off', role: 'employee', passwordHash: hash, active: false },
    { id: 'n', email: 'nopw@claimflow.test', name: 'NoPw', role: 'employee', passwordHash: null },
  ] });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });

const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]);
async function csrf() {
  const r = await fetch(`${base}/api/auth/csrf`);
  return { token: ((await r.json()) as { csrfToken: string }).csrfToken, cookie: cookiesOf(r)[0] };
}
async function signIn(email: string, password: string, cookie?: string) {
  const pre = await csrf();
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': pre.token, cookie: [pre.cookie, cookie].filter(Boolean).join('; ') },
    body: JSON.stringify({ email, password }),
  });
  return { r, text: await r.text(), pre };
}
const sidOf = (r: Response) => cookiesOf(r).find((c) => c.startsWith('sid='))!;

test('AC-1 sign-in creates a session; old session deleted; csrf_pre cleared', async () => {
  const first = await signIn('admin@claimflow.test', PW);
  const oldCookie = sidOf(first.r);
  const second = await signIn('ADMIN@claimflow.test', PW, oldCookie);
  assert.equal(second.r.status, 200);
  const body = JSON.parse(second.text);
  assert.deepEqual(Object.keys(body).sort(), ['csrfToken', 'id', 'name', 'role']);
  assert.equal(body.role, 'admin');
  assert.match(second.r.headers.getSetCookie().find((c) => c.startsWith('csrf_pre='))!, /Max-Age=0/);
  const sid = sidOf(second.r);
  assert.notEqual(sid, oldCookie);
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie: oldCookie } })).status, 401);
  const s = await fetch(`${base}/api/auth/session`, { headers: { cookie: sid } });
  assert.deepEqual(await s.json(), body);
});

test('AC-2 every failure is a byte-identical 401 and costs one compare', async () => {
  const long = 'x'.repeat(73);
  const cases: [string, string][] = [
    ['admin@claimflow.test', 'wrong password'], ['nobody@claimflow.test', PW], ['off@claimflow.test', PW],
    ['nopw@claimflow.test', PW], ['admin@claimflow.test', long],
  ];
  const timings: number[] = [];
  const bodies = new Set<string>();
  for (const [e, p] of cases) {
    const t = performance.now();
    const { r, text } = await signIn(e, p);
    timings.push(performance.now() - t);
    assert.equal(r.status, 401);
    bodies.add(text);
    assert.equal(r.headers.getSetCookie().some((c) => c.startsWith('sid=')), false);
  }
  assert.deepEqual([...bodies], ['{"error":"invalid_credentials"}']);
  assert.ok(timings.every((t) => t > 50), `each failure runs a cost-12 compare: ${timings}`); // cost 12 is ~200+ ms; no short-circuit
});

test('AC-4 sign-out then old cookie is 401; idle 30 min ok, +1 s expires', async () => {
  const { r, text } = await signIn('admin@claimflow.test', PW);
  const sid = sidOf(r), token = JSON.parse(text).csrfToken;
  const out = await fetch(`${base}/api/auth/sign-out`, { method: 'POST', headers: { cookie: sid, 'x-csrf-token': token } });
  assert.equal(out.status, 204);
  assert.match(out.headers.getSetCookie().find((c) => c.startsWith('sid='))!, /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie: sid } })).status, 401);

  const f = await signIn('admin@claimflow.test', PW);
  const c2 = sidOf(f.r), get = () => fetch(`${base}/api/auth/session`, { headers: { cookie: c2 } });
  tick(30 * 60_000);
  assert.equal((await get()).status, 200); // resets the timer
  tick(30 * 60_000 + 1000);
  const expired = await get();
  assert.equal(expired.status, 401);
  assert.match(expired.headers.getSetCookie().find((c) => c.startsWith('sid='))!, /Max-Age=0/);
});
