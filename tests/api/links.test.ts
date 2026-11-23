import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createMailer } from '../../api/src/mailer.js';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { sha256 } from '../../api/src/auth/secrets.js';

// Minimal SMTP sink: enough protocol for nodemailer to deliver one message.
function sink() {
  const msgs: string[] = [];
  const srv = net.createServer((s) => {
    let data = '', inData = false;
    s.write('220 test\r\n');
    s.on('data', (c) => {
      data += c;
      if (inData) {
        if (!data.endsWith('\r\n.\r\n')) return;
        msgs.push(data); data = ''; inData = false; s.write('250 ok\r\n'); return;
      }
      for (const l of data.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(l)) s.write('250 test\r\n');
        else if (/^DATA/i.test(l)) { s.write('354 go\r\n'); inData = true; }
        else if (/^QUIT/i.test(l)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
      data = '';
    });
  });
  return new Promise<{ port: number; msgs: string[]; close: () => void }>((r) =>
    srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as net.AddressInfo).port, msgs, close: () => srv.close() })));
}

test('linkMail delivers the set-password link over SMTP', async () => {
  const s = await sink();
  await createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('set_password', 'a@b.test', 'http://app.test/set-password#token=abc');
  s.close();
  assert.equal(s.msgs.length, 1);
  assert.match(s.msgs[0], /http:\/\/app\.test\/set-password#token=abc/);
});

test('linkMail rejects when SMTP is unreachable', async () => {
  const s = await sink();
  s.close();
  await assert.rejects(createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('reset', 'a@b.test', 'http://x'));
});

test('linkMail states the 1 hour validity for reset links', async () => {
  const s = await sink();
  await createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('reset', 'a@b.test', 'http://app.test/reset-password#token=abc');
  s.close();
  assert.match(s.msgs[0], /within 1 hour/);
});

// ---- resend-link (CLAIM-2-S6) ----
const PW = 'correct horse battery';
const prisma = new PrismaClient();
let app: Server, base: string, smtpDown = false, offsetMs = 0;
const sent: { to: string; url: string }[] = [];
const fakeMailer = { async linkMail(_k: string, to: string, url: string) { if (smtpDown) throw new Error('down'); sent.push({ to, url }); } };
const tokenOf = (url: string) => url.split('#token=')[1];

before(async () => {
  const hash = await bcrypt.hash(PW, 4);
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.createMany({ data: [
    { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: hash },
    { id: 'e', email: 'emp@claimflow.test', name: 'Emp', role: 'employee', passwordHash: hash },
    { id: 'm', email: 'mgr@claimflow.test', name: 'Mgr', role: 'manager', passwordHash: hash },
    { id: 'f', email: 'fin@claimflow.test', name: 'Fin', role: 'finance', passwordHash: hash },
    { id: 'off', email: 'off@claimflow.test', name: 'Off', role: 'employee', passwordHash: null, active: false },
  ] });
  app = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(Date.now() + offsetMs), mailer: fakeMailer as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as net.AddressInfo).port}`;
});
after(async () => { app.close(); await prisma.$disconnect(); });

async function signIn(email: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const csrf = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email, password: PW }),
  });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
type S = { cookie: string; csrf: string } | null;
const resend = (s: S, id: string) =>
  fetch(`${base}/api/users/${id}/resend-link`, { method: 'POST', headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });
const setPw = async (token: string) => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const csrf = ((await pre.json()) as { csrfToken: string }).csrfToken;
  return fetch(`${base}/api/auth/set-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ token, password: 'a-valid-password-1' }),
  });
};
async function newUser(id: string, token?: { raw: string; expiresAt: Date }) {
  await prisma.user.create({ data: { id, email: `${id}@claimflow.test`, name: id, role: 'employee', passwordHash: null } });
  if (token) await prisma.oneTimeToken.create({ data: { hash: sha256(token.raw), userId: id, purpose: 'set_password', expiresAt: token.expiresAt } });
}

test('resend AC-1 after expiry: 204, new mail, new link succeeds once', async () => {
  await newUser('u1', { raw: 'old1', expiresAt: new Date(Date.now() + 24 * 3_600_000) });
  offsetMs = 24 * 3_600_000 + 1000;
  try {
    const a = await signIn('admin@claimflow.test'); // sessions idle out at 30 min, so sign in at the shifted time
    assert.equal((await setPw('old1')).status, 400);
    const n = sent.length;
    assert.equal((await resend(a, 'u1')).status, 204);
    assert.equal(sent.length, n + 1);
    assert.equal(sent[n].to, 'u1@claimflow.test');
    const raw = tokenOf(sent[n].url);
    assert.equal((await setPw(raw)).status, 200);
    assert.equal((await setPw(raw)).status, 400);
  } finally { offsetMs = 0; }
});

test('resend AC-2 invalidates the previous link, each resend the one before', async () => {
  const a = await signIn('admin@claimflow.test');
  await newUser('u2', { raw: 'old2', expiresAt: new Date(Date.now() + 3_600_000) });
  await resend(a, 'u2');
  await resend(a, 'u2');
  const [, t1, t2] = sent.slice(-3).length === 3 ? sent.slice(-3) : [null, sent[sent.length - 2], sent[sent.length - 1]];
  const old = await setPw('old2');
  assert.equal(old.status, 400);
  assert.deepEqual(await old.json(), { error: 'invalid_token' });
  assert.equal((await setPw(tokenOf(t1.url))).status, 400);
  assert.equal((await setPw(tokenOf(t2.url))).status, 200);
  assert.equal(await prisma.oneTimeToken.count({ where: { userId: 'u2', usedAt: null } }), 0);
});

test('resend AC-3 password set / deactivated → 409, no token created', async () => {
  const a = await signIn('admin@claimflow.test');
  const before = await prisma.oneTimeToken.count();
  const r1 = await resend(a, 'e');
  assert.equal(r1.status, 409);
  assert.deepEqual(await r1.json(), { error: 'password_already_set' });
  const r2 = await resend(a, 'off');
  assert.equal(r2.status, 409);
  assert.deepEqual(await r2.json(), { error: 'user_inactive' });
  assert.equal(await prisma.oneTimeToken.count(), before);
});

test('resend AC-4 401 unauthenticated, 403 non-admins, 404 unknown for admin', async () => {
  assert.equal((await resend(null, 'u1')).status, 401);
  for (const e of ['emp', 'mgr', 'fin']) assert.equal((await resend(await signIn(`${e}@claimflow.test`), 'u1')).status, 403);
  assert.equal((await resend(await signIn('admin@claimflow.test'), 'ghost')).status, 404);
});

test('resend AC-5 SMTP down → 502 exact body; later resend 204', async () => {
  const a = await signIn('admin@claimflow.test');
  await newUser('u5');
  smtpDown = true;
  const r = await resend(a, 'u5');
  smtpDown = false;
  assert.equal(r.status, 502);
  assert.equal(await r.text(), '{"error":"smtp_unavailable"}');
  assert.equal((await resend(a, 'u5')).status, 204);
});
