import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { sha256 } from '../../api/src/auth/secrets.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string, smtpDown = false;
const sent: { to: string; url: string }[] = [];
const mailer = { async linkMail(_k: string, to: string, url: string) { if (smtpDown) throw new Error('down'); sent.push({ to, url }); } };

before(async () => {
  const hash = await bcrypt.hash(PW, 4);
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.createMany({ data: [
    { id: 'a', email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: hash },
    { id: 'e', email: 'emp@claimflow.test', name: 'Emp', role: 'employee', passwordHash: hash },
    { id: 'm', email: 'mgr@claimflow.test', name: 'Mgr', role: 'manager', passwordHash: hash },
    { id: 'f', email: 'fin@claimflow.test', name: 'Fin', role: 'finance', passwordHash: hash },
    { id: 'mi', email: 'mgr-off@claimflow.test', name: 'MgrOff', role: 'manager', passwordHash: hash, active: false },
  ] });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: mailer as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });

async function signIn(email: string) {
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
const create = (s: { cookie: string; csrf: string } | null, body: unknown) =>
  fetch(`${base}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}) }, body: JSON.stringify(body) });
const valid = { name: 'Alice', email: 'Alice@Example.com', role: 'employee', managerId: 'm' };

test('AC-1 401 without session, 403 for non-admins, no rows added', async () => {
  const n = await prisma.user.count();
  assert.equal((await create(null, valid)).status, 401);
  for (const e of ['emp', 'mgr', 'fin']) {
    const r = await create(await signIn(`${e}@claimflow.test`), valid);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal(await prisma.user.count(), n);
});

test('AC-2 valid create, lowercase email, null hash, email sent, duplicates 409', async () => {
  const a = await signIn('admin@claimflow.test');
  const r = await create(a, valid);
  assert.equal(r.status, 201);
  const b = (await r.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(b).sort(), ['active', 'email', 'id', 'managerId', 'name', 'role']);
  assert.equal(r.headers.get('location'), `/api/users/${b.id}`);
  const row = await prisma.user.findUniqueOrThrow({ where: { id: b.id as string } });
  assert.equal(row.email, 'alice@example.com');
  assert.equal(row.passwordHash, null);
  assert.equal(sent.length, 1);
  const raw = sent[0].url.split('#token=')[1];
  assert.equal(sent[0].url, `http://app.test/set-password#token=${raw}`);
  const t = await prisma.oneTimeToken.findUniqueOrThrow({ where: { hash: sha256(raw) } });
  assert.equal(t.purpose, 'set_password');
  for (const email of ['ALICE@example.com', 'admin@claimflow.test']) {
    const d = await create(a, { ...valid, email });
    assert.equal(d.status, 409);
    assert.deepEqual(await d.json(), { error: 'email_taken' });
  }
});

test('AC-3 invalid input → 400, invalid manager → 409, 0 rows added', async () => {
  const a = await signIn('admin@claimflow.test');
  const n = await prisma.user.count();
  const bads = [
    { ...valid, email: 'nope' }, { ...valid, name: '' }, { ...valid, name: '   ' }, { ...valid, name: 'x'.repeat(101) },
    { ...valid, email: 'x'.repeat(250) + '@e.com' }, { ...valid, role: 'boss' },
  ];
  for (const b of bads) {
    const r = await create(a, { ...b, email: b.email === valid.email ? 'ok1@example.com' : b.email });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: string; reason: string };
    assert.equal(j.error, 'invalid_input');
    assert.ok(j.reason);
  }
  for (const managerId of ['ghost', 'mi', 'e']) {
    const r = await create(a, { ...valid, email: 'ok2@example.com', managerId });
    assert.equal(r.status, 409);
    const j = (await r.json()) as { error: string; reason: string };
    assert.equal(j.error, 'hierarchy_violation');
    assert.ok(j.reason);
  }
  assert.equal(await prisma.user.count(), n);
});

test('AC-4 concurrent same-email creates: one 201, one 409', async () => {
  const a = await signIn('admin@claimflow.test');
  const rs = await Promise.all([create(a, { ...valid, email: 'race@example.com' }), create(a, { ...valid, email: 'race@example.com' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  const lose = rs.find((r) => r.status === 409)!;
  assert.deepEqual(await lose.json(), { error: 'email_taken' });
});

test('AC-5 SMTP down → 502 smtp_unavailable, user persists with null hash', async () => {
  const a = await signIn('admin@claimflow.test');
  smtpDown = true;
  const r = await create(a, { ...valid, email: 'down@example.com' });
  smtpDown = false;
  assert.equal(r.status, 502);
  assert.equal(await r.text(), '{"error":"smtp_unavailable"}');
  const u = await prisma.user.findUniqueOrThrow({ where: { email: 'down@example.com' } });
  assert.equal(u.passwordHash, null);
});
