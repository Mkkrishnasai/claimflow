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
const out: string[] = [];
let srv: Server, base: string;

before(async () => {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: await bcrypt.hash(PW, 10) } });
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock: () => new Date() } }).listen(0, '127.0.0.1');
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

test('AC-3 one access line per sign-in with authEvent; no userId for unknown email', async () => {
  out.length = 0;
  assert.equal((await signIn('admin@claimflow.test', PW)).status, 200);
  assert.equal((await signIn('nobody@claimflow.test', PW)).status, 401);
  await settle();
  const signins = lines().filter((l) => l.path === '/api/auth/sign-in');
  assert.equal(signins.length, 2);
  assert.equal(lines().filter((l) => l.path === '/api/auth/sign-in' && l.requestId).length, 2);
  const [ok, bad] = signins;
  assert.equal(ok.authEvent, 'sign_in_ok');
  assert.equal(ok.userId, 'a');
  assert.equal(bad.authEvent, 'sign_in_failed');
  assert.ok(!('userId' in bad));
  assert.equal(lines().length, 4); // 2 csrf + 2 sign-in: no extra lines
});

test('AC-4 full flow: marker password absent from logs and Mailpit; no secrets in access lines', async () => {
  out.length = 0;
  const marker = `Leak-Marker-${crypto.randomUUID()}`;
  await prisma.user.update({ where: { id: 'a' }, data: { passwordHash: await bcrypt.hash(marker, 12) } });
  const r = await signIn('admin@claimflow.test', marker);
  assert.equal(r.status, 200);
  const sid = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const { csrfToken } = (await r.json()) as { csrfToken: string };
  await signIn('admin@claimflow.test', `${marker}-wrong`);
  await fetch(`${base}/api/auth/sign-out`, { method: 'POST', headers: { cookie: sid, 'x-csrf-token': csrfToken } });
  await settle();
  const all = out.join('');
  for (const secret of [marker, csrfToken, sid.slice(4), 'admin@claimflow.test', '$2a$', '$2b$']) assert.ok(!all.includes(secret), secret);
  const mp = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(marker)}`).catch(() => null);
  if (mp) assert.equal(((await mp.json()) as { messages_count: number }).messages_count, 0);
  else console.log('Mailpit not reachable on :8025: email half of AC-4 skipped');
});
