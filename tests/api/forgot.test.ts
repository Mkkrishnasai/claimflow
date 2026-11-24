import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { sha256 } from '../../api/src/auth/secrets.js';

const PW = 'correct horse battery';
const NEW = 'brand new passphrase';
const T0 = new Date('2026-01-01T00:00:00Z');
const prisma = new PrismaClient();
let srv: Server, base: string, now = T0, gate: Promise<void> | undefined;
const sent: { to: string; url: string }[] = [];
const lines: string[] = [];
const mailer = { async linkMail(_k: string, to: string, url: string) { if (gate) await gate; sent.push({ to, url }); } };
const at = (sec: number) => { now = new Date(T0.getTime() + sec * 1000); };
const tokenOf = (url: string) => url.split('#token=')[1];
const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  const hash = await bcrypt.hash(PW, 4);
  await prisma.oneTimeToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  await prisma.user.createMany({ data: [
    { id: 'k', email: 'known@claimflow.test', name: 'K', role: 'employee', passwordHash: hash },
    { id: 'd', email: 'off@claimflow.test', name: 'D', role: 'employee', passwordHash: hash, active: false },
    { id: 'n', email: 'nopw@claimflow.test', name: 'N', role: 'employee', passwordHash: null },
  ] });
  srv = createApp({ log: createLogger({ write: (s) => lines.push(String(s)) }), deps: { prisma, clock: () => now, mailer: mailer as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  gate = undefined; at(0); sent.length = 0; lines.length = 0;
  await prisma.loginAttempt.deleteMany(); await prisma.oneTimeToken.deleteMany(); await prisma.session.deleteMany();
});

async function post(path: string, body: unknown) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify(body),
  });
}
const forgot = (email: string) => post('/api/auth/forgot-password', { email });
const reset = (token: string, password = NEW) => post('/api/auth/set-password', { token, password });
const signIn = async (password: string) => {
  const r = await post('/api/auth/sign-in', { email: 'known@claimflow.test', password });
  return { status: r.status, cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))?.split(';')[0] };
};
const snap = async (r: Response) => [r.status, await r.text()];
const tokens = () => prisma.oneTimeToken.count({ where: { purpose: 'reset' } });

test('AC-1 link works once within 1 h, not again, not at 1 h + 1 s; sessions end, sign-in works', async () => {
  const s = await signIn(PW);
  await forgot('known@claimflow.test'); await settle();
  at(3599);
  assert.equal((await reset(tokenOf(sent[0].url))).status, 200);
  const again = await reset(tokenOf(sent[0].url));
  assert.deepEqual(await snap(again), [400, '{"error":"invalid_token"}']);
  const me = await fetch(`${base}/api/auth/session`, { headers: { cookie: s.cookie! } });
  assert.equal(me.status, 401);
  assert.equal((await signIn(NEW)).status, 200);
  assert.equal((await reset('x', 'short')).status, 400); // S5 password rule applies

  at(10_000); await forgot('known@claimflow.test'); await settle();
  at(10_000 + 3601);
  assert.deepEqual(await snap(await reset(tokenOf(sent[1].url))), [400, '{"error":"invalid_token"}']);
  await prisma.user.update({ where: { id: 'k' }, data: { passwordHash: await bcrypt.hash(PW, 4) } });
});

test('AC-2 identical responses for known, unknown, deactivated, no-password; mail only for known, after response', async () => {
  gate = new Promise(() => {}); // mail never completes: the response must not wait for it
  const rs = [] as unknown[];
  for (const e of ['known@claimflow.test', 'ghost@claimflow.test', 'off@claimflow.test', 'nopw@claimflow.test']) rs.push(await snap(await forgot(e)));
  for (const r of rs) assert.deepEqual(r, [200, '{"ok":true}']);
  gate = undefined;
});

test('AC-2 mail: 1 for known, 0 for others', async () => {
  for (const e of ['known@claimflow.test', 'ghost@claimflow.test', 'off@claimflow.test', 'nopw@claimflow.test']) await forgot(e);
  await settle();
  assert.deepEqual(sent.map((m) => m.to), ['known@claimflow.test']);
  assert.match(sent[0].url, /^http:\/\/app\.test\/reset-password#token=/);
  assert.ok(lines.some((l) => l.includes('reset_requested')));
});

test('400 for malformed or overlong email', async () => {
  for (const email of ['nope', 'x'.repeat(250) + '@e.com', 5]) assert.equal((await post('/api/auth/forgot-password', { email })).status, 400);
});

test('AC-3 timing medians within 100 ms; tokens added only for known', async () => {
  const hash = await bcrypt.hash(PW, 4);
  const N = 50, cases = ['known', 'unknown', 'off'];
  await prisma.user.createMany({ data: Array.from({ length: N }, (_, i) => [
    { id: `tk${i}`, email: `tk${i}@claimflow.test`, name: 'T', role: 'employee' as const, passwordHash: hash },
    { id: `td${i}`, email: `td${i}@claimflow.test`, name: 'T', role: 'employee' as const, passwordHash: hash, active: false },
  ]).flat() });
  const med: Record<string, number> = {};
  for (const c of cases) {
    const ts: number[] = [];
    for (let i = 0; i < N; i++) {
      const email = c === 'known' ? `tk${i}@claimflow.test` : c === 'off' ? `td${i}@claimflow.test` : `tu${i}@claimflow.test`;
      now = new Date(now.getTime() + 3_700_000); // CR-1: stay under the per-IP hourly quota
      const before = await tokens(), t = performance.now();
      assert.equal((await forgot(email)).status, 200);
      ts.push(performance.now() - t);
      assert.equal((await tokens()) - before, c === 'known' ? 1 : 0);
    }
    med[c] = ts.sort((a, b) => a - b)[N / 2];
  }
  const v = Object.values(med);
  assert.ok(Math.max(...v) - Math.min(...v) <= 100, JSON.stringify(med));
  await prisma.user.deleteMany({ where: { id: { startsWith: 't' } } });
});

test('AC-4 4th request in an hour: identical body, 0 mail, 0 tokens, earlier link valid; unknown too', async () => {
  for (let i = 0; i < 3; i++) { await forgot('known@claimflow.test'); await forgot('ghost@claimflow.test'); }
  await settle();
  const n = sent.length, t = await tokens();
  assert.equal(n, 3);
  for (const e of ['known@claimflow.test', 'ghost@claimflow.test']) assert.deepEqual(await snap(await forgot(e)), [200, '{"ok":true}']);
  await settle();
  assert.equal(sent.length, n);
  assert.equal(await tokens(), t);
  assert.equal(await prisma.oneTimeToken.count({ where: { purpose: 'reset', usedAt: null } }), 1); // latest link still live
  at(3601); await forgot('known@claimflow.test'); await settle();
  assert.equal(sent.length, n + 1); // quota resets after the hour
  await prisma.user.update({ where: { id: 'k' }, data: { passwordHash: await bcrypt.hash(PW, 4) } });
});

test('AC-5 newer request invalidates the earlier unused link', async () => {
  await forgot('known@claimflow.test'); await forgot('known@claimflow.test'); await settle();
  assert.deepEqual(await snap(await reset(tokenOf(sent[0].url))), [400, '{"error":"invalid_token"}']);
  assert.equal((await reset(tokenOf(sent[1].url))).status, 200);
});

test('AC-6 parallel replay gives exactly one 200; deactivated user token fails and sets no password', async () => {
  await forgot('known@claimflow.test'); await settle();
  const t = tokenOf(sent[0].url);
  const rs = await Promise.all([reset(t), reset(t)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);

  await prisma.user.update({ where: { id: 'k' }, data: { passwordHash: await bcrypt.hash(PW, 4) } });
  const before = (await prisma.user.findUniqueOrThrow({ where: { id: 'k' } })).passwordHash;
  await forgot('known@claimflow.test'); await settle();
  await prisma.user.update({ where: { id: 'k' }, data: { active: false } });
  assert.deepEqual(await snap(await reset(tokenOf(sent[1].url))), [400, '{"error":"invalid_token"}']);
  await prisma.user.update({ where: { id: 'k' }, data: { active: true } });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: 'k' } })).passwordHash, before);
  assert.equal(sha256('x').length, 64);
});
