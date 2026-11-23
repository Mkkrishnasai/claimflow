import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { verifyPassword } from '../../api/src/auth/secrets.js';

const PW = 'correct horse battery';
const E = 'lock@claimflow.test';
const T0 = new Date('2026-01-01T00:00:00Z');
const prisma = new PrismaClient();
let srv: Server, base: string, now = T0, gate: Promise<void> | undefined;
const clock = () => now;
const at = (min: number, sec = 0) => { now = new Date(T0.getTime() + min * 60_000 + sec * 1000); };
// A correct-password compare is held open while `gate` is set (the race rows).
const verify: typeof verifyPassword = async (pw, hash) => { if (gate && pw === PW) await gate; return verifyPassword(pw, hash); };

before(async () => {
  const hash = await bcrypt.hash(PW, 12);
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'l', email: E, name: 'L', role: 'employee', passwordHash: hash } });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock, verify } as never }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });
beforeEach(async () => { gate = undefined; at(0); await prisma.loginAttempt.deleteMany(); await prisma.session.deleteMany(); });

async function signIn(email: string, password: string) {
  const c = await fetch(`${base}/api/auth/csrf`);
  const token = ((await c.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: c.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, text: await r.text() };
}
const row = (email = E) => prisma.loginAttempt.findUnique({ where: { kind_email: { kind: 'sign_in', email } } });
const fail = async (n: number, email = E) => { for (let i = 0; i < n; i++) assert.equal((await signIn(email, 'wrong')).status, 401); };
const INVALID = '{"error":"invalid_credentials"}';

test('AC-1 5th failure locks, 6th refused even when correct, succeeds at +15 min +1 s', async () => {
  await fail(5);
  const six = await signIn(E, PW);
  assert.deepEqual([six.status, six.text], [401, INVALID]);
  at(14, 59); assert.equal((await signIn(E, PW)).status, 401); // still locked just before +15 min
  at(15, 1); assert.equal((await signIn(E, PW)).status, 200);
});

test('AC-2 (a) success resets the count; 4 more failures do not lock', async () => {
  await fail(4);
  assert.equal((await signIn(E, PW)).status, 200);
  assert.equal(await row(), null);
  await fail(4);
  assert.equal((await row())!.lockedUntil, null);
  assert.equal((await signIn(E, PW)).status, 200);
});

test('AC-3 (c) attempts during the lock do not extend it and write nothing', async () => {
  await fail(5);
  const before = await row();
  at(7);
  for (let i = 0; i < 3; i++) assert.equal((await signIn(E, i ? 'wrong' : PW)).status, 401);
  assert.deepEqual(await row(), before);
  at(15, 1);
  assert.equal((await signIn(E, PW)).status, 200);
});

test('AC-4 (d) a failure after the window ends starts a new window', async () => {
  await fail(4);
  at(16);
  await fail(1);
  const r = (await row())!;
  assert.equal(r.count, 1);
  assert.equal(r.lockedUntil, null);
  assert.equal(r.windowStart.getTime(), now.getTime());
});

test('AC-5 (e) unknown email: same status, body and lock timing', async () => {
  const ghost = 'ghost@claimflow.test';
  await fail(5, ghost);
  const six = await signIn(ghost, PW);
  assert.deepEqual([six.status, six.text], [401, INVALID]);
  assert.equal((await row(ghost))!.lockedUntil!.getTime(), T0.getTime() + 15 * 60_000);
  assert.equal((await signIn('GHOST@claimflow.test', 'x')).text, INVALID); // keyed by normalised email
  at(15, 1);
  assert.equal((await signIn(ghost, PW)).status, 401); // no account: still 401, but no longer locked
  assert.equal((await row(ghost))!.count, 1);
});

test('AC-6 concurrent guesses cannot beat the lock; 2 concurrent 5th failures lock once', async () => {
  await fail(0);
  let release!: () => void;
  gate = new Promise((r) => { release = r; });
  const held = signIn(E, PW);
  const wrong = await Promise.all(Array.from({ length: 10 }, () => signIn(E, 'wrong')));
  const locked = (await row())!.lockedUntil;
  assert.ok(locked);
  assert.equal(locked.getTime(), T0.getTime() + 15 * 60_000);
  release();
  const all = [...wrong, await held];
  assert.equal(all.length, 11);
  assert.ok(all.every((x) => x.status === 401 && x.text === INVALID));
  assert.equal(await prisma.session.count(), 0);
  assert.equal((await row())!.lockedUntil!.getTime(), locked.getTime());
});

test('AC-6 two concurrent 5th failures produce exactly one lock', async () => {
  await fail(3);
  await Promise.all([signIn(E, 'wrong'), signIn(E, 'wrong')]);
  const r = (await row())!;
  assert.equal(r.count, 5);
  assert.equal(r.lockedUntil!.getTime(), T0.getTime() + 15 * 60_000);
});
