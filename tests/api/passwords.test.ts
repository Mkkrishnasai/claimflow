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

test('AC-1 cost-10 hash upgraded to cost 12 on first sign-in, unchanged on second', async () => {
  const h = async () => (await prisma.user.findUniqueOrThrow({ where: { id: 'a' } })).passwordHash!;
  assert.match(await h(), /^\$2[aby]\$10\$/);
  assert.equal((await signIn('admin@claimflow.test', PW)).status, 200);
  const up = await h();
  assert.match(up, /^\$2[aby]\$12\$/);
  assert.equal((await signIn('admin@claimflow.test', PW)).status, 200);
  assert.equal(await h(), up);
});
