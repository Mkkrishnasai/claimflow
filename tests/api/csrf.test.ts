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
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: await bcrypt.hash(PW, 12) } });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date() } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  fetch(`${base}/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function pre() {
  const r = await fetch(`${base}/api/auth/csrf`);
  return { token: ((await r.json()) as { csrfToken: string }).csrfToken, cookie: r.headers.getSetCookie()[0].split(';')[0] };
}
const creds = { email: 'admin@claimflow.test', password: PW };

test('sign-in: no token, mismatched token → 403 csrf and no session; valid proceeds', async () => {
  const p = await pre();
  for (const h of [{ cookie: p.cookie }, { cookie: p.cookie, 'x-csrf-token': 'nope' }, { 'x-csrf-token': p.token }]) {
    const r = await post('/sign-in', h, creds);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'csrf' });
  }
  assert.equal(await prisma.session.count(), 0);
  assert.equal((await post('/sign-in', { cookie: p.cookie, 'x-csrf-token': p.token }, creds)).status, 200);
});

test('sign-out: no token, mismatched (incl. pre-session) token → 403 and session survives; valid proceeds', async () => {
  const p = await pre();
  const r = await post('/sign-in', { cookie: p.cookie, 'x-csrf-token': p.token }, creds);
  const sid = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const token = ((await r.json()) as { csrfToken: string }).csrfToken;
  for (const h of [{ cookie: sid }, { cookie: sid, 'x-csrf-token': 'nope' }, { cookie: sid, 'x-csrf-token': p.token }]) {
    const o = await post('/sign-out', h);
    assert.equal(o.status, 403);
    assert.deepEqual(await o.json(), { error: 'csrf' });
  }
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie: sid } })).status, 200);
  assert.equal((await post('/sign-out', { cookie: sid, 'x-csrf-token': token })).status, 204);
});

test('session token is rejected on pre-session routes', async () => {
  const p = await pre();
  const r = await post('/sign-in', { cookie: p.cookie, 'x-csrf-token': p.token }, creds);
  const sid = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const token = ((await r.json()) as { csrfToken: string }).csrfToken;
  assert.equal((await post('/sign-in', { cookie: p.cookie, 'x-csrf-token': token }, creds)).status, 403);
  void sid;
});
