import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { createMailer } from '../../api/src/mailer.js';

// CR-1 hardening: per-IP limits, retention, security headers, mailer TLS.
const PW = 'correct horse battery';
const T0 = new Date('2026-01-01T00:00:00Z');
const prisma = new PrismaClient();
let srv: Server, base: string, now = T0;
const sent: string[] = [];
const mailer = { async linkMail(_k: string, to: string) { sent.push(to); } };

before(async () => {
  await prisma.session.deleteMany(); await prisma.oneTimeToken.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.create({ data: { id: 'h', email: 'h@claimflow.test', name: 'H', role: 'employee', passwordHash: await bcrypt.hash(PW, 4) } });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => now, mailer: mailer as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });
beforeEach(async () => { now = T0; sent.length = 0; await prisma.loginAttempt.deleteMany(); });

async function post(path: string, body: unknown, xff?: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  return fetch(`${base}${path}`, { method: 'POST', headers: { ...(xff && { 'x-forwarded-for': xff }), 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify(body) });
}
const signIn = (email: string, password: string) => post('/api/auth/sign-in', { email, password });

test('per-IP sign-in limit: 20 failures across emails block the IP, even for a good password; window expires', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await signIn(`u${i}@claimflow.test`, 'wrong password!')).status, 401);
  const blocked = await signIn('h@claimflow.test', PW);
  assert.equal(blocked.status, 401);
  assert.deepEqual(await blocked.json(), { error: 'invalid_credentials' });
  now = new Date(T0.getTime() + 15 * 60_000);
  assert.equal((await signIn('h@claimflow.test', PW)).status, 200);
});

test('per-IP sign-in limit is per forwarded client: one blocked client does not block another (SEC-001)', async () => {
  let n = 0; // distinct emails so the per-email lock does not stop the IP counter
  const bad = (xff: string) => post('/api/auth/sign-in', { email: `x${n++}@claimflow.test`, password: 'wrong password!' }, xff);
  for (let i = 0; i < 20; i++) await bad('203.0.113.1');
  const row = (ip: string) => prisma.loginAttempt.findUnique({ where: { kind_email: { kind: 'sign_in_ip', email: ip } } });
  assert.equal((await row('203.0.113.1'))?.count, 20);
  assert.equal(await row('127.0.0.1'), null);
  const other = await post('/api/auth/sign-in', { email: 'h@claimflow.test', password: PW }, '203.0.113.2');
  assert.equal(other.status, 200);
  const blocked = await post('/api/auth/sign-in', { email: 'h@claimflow.test', password: PW }, '203.0.113.1');
  assert.equal(blocked.status, 401);
});

test('per-IP forgot limit: 20 requests per hour, then identical 200 with no token or mail', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await post('/api/auth/forgot-password', { email: `f${i}@claimflow.test` })).status, 200);
  const r = await post('/api/auth/forgot-password', { email: 'h@claimflow.test' });
  assert.deepEqual([r.status, await r.json()], [200, { ok: true }]);
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(await prisma.oneTimeToken.count(), 0);
  assert.deepEqual(sent, []);
});

test('LoginAttempt rows older than 24 h are deleted by the next throttled write', async () => {
  await prisma.loginAttempt.createMany({ data: [
    { kind: 'sign_in', email: 'old@x.test', windowStart: new Date(T0.getTime() - 25 * 3_600_000), count: 1 },
    { kind: 'sign_in', email: 'new@x.test', windowStart: new Date(T0.getTime() - 23 * 3_600_000), count: 1 },
  ] });
  await signIn('nobody@claimflow.test', 'wrong password!');
  const emails = (await prisma.loginAttempt.findMany()).map((r) => r.email);
  assert.ok(!emails.includes('old@x.test'));
  assert.ok(emails.includes('new@x.test'));
});

test('security headers on 200, 401 and 404; no X-Powered-By', async () => {
  for (const path of ['/health', '/api/claims', '/nope']) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.headers.get('x-powered-by'), null, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('mailer requires STARTTLS in production only', async () => {
  const smtp = net.createServer((s) => { // plain SMTP that never offers STARTTLS
    s.write('220 test\r\n');
    s.on('data', (d) => { const c = String(d); if (c.startsWith('EHLO')) s.write('250 test\r\n'); else if (/^(MAIL|RCPT)/.test(c)) s.write('250 ok\r\n'); else if (c.startsWith('DATA')) s.write('354 go\r\n'); else if (c.includes('\r\n.\r\n')) s.write('250 queued\r\n'); else if (c.startsWith('QUIT')) s.end('221 bye\r\n'); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => smtp.once('listening', r));
  const mk = () => createMailer({ smtp: { host: '127.0.0.1', port: (smtp.address() as AddressInfo).port, user: '', pass: '' } } as never);
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(mk().notifyMail('a@b.test', 's', 't'));
    process.env.NODE_ENV = 'test';
    await mk().notifyMail('a@b.test', 's', 't');
  } finally { process.env.NODE_ENV = prev; smtp.close(); }
});
