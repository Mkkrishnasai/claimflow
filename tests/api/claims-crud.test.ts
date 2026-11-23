import { test, before, after, beforeEach } from 'node:test';
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
const out: string[] = [];
const mailer = { async linkMail() {}, async reassignedMail() {} };
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)); // injected, strictly increasing

const wipe = async () => {
  await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
};
async function seed() {
  await wipe();
  const hash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, managerId: string | null = null) => ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, active: true, passwordHash: hash });
  await prisma.user.createMany({ data: [u('mgr', 'manager'), u('emp', 'employee', 'mgr'), u('fin', 'finance')] });
  out.length = 0;
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock, mailer: mailer as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

type S = { cookie: string; csrf: string };
async function signIn(id: string): Promise<S> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }),
  });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
const post = (s: S, body: unknown, raw?: string) =>
  fetch(`${base}/api/claims`, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
const get = (s: S | null, path: string) => fetch(`${base}/api${path}`, { headers: s ? { cookie: s.cookie } : {} });
const line = (o: Record<string, unknown> = {}) => ({ date: '2026-03-01', categoryCode: 'meals', amountCents: 1250, description: 'Lunch', ...o });
const claim = (o: Record<string, unknown> = {}) => ({ title: 'Berlin trip', purpose: 'Client workshop visit', lines: [line()], ...o });
type J = Record<string, any>;

test('AC-1 creates a draft with positions, Location and integer total', async () => {
  const s = await signIn('emp');
  const r = await post(s, claim({ lines: [line(), line({ amountCents: 300 })] }));
  assert.equal(r.status, 201);
  const j = (await r.json()) as J;
  assert.equal(r.headers.get('location'), `/api/claims/${j.id}`);
  assert.equal(j.status, 'draft'); assert.equal(j.claimantId, 'emp'); assert.equal(j.totalCents, 1550);
  assert.deepEqual(j.lines.map((l: J) => [l.position, l.amountCents]), [[1, 1250], [2, 300]]);
});

test('AC-2 amountCents must be a safe integer in 1..1000000; 0 rows added on refusal', async () => {
  const s = await signIn('emp');
  for (const amountCents of [12.5, '1250', null, 0, -1, 1000001, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await post(s, claim({ lines: [line(), line({ amountCents })] }));
    assert.equal(r.status, 422, String(amountCents));
    const j = (await r.json()) as J;
    assert.equal(j.error, 'invalid_input'); assert.match(j.reason, /amountCents/);
  }
  assert.equal(await prisma.claim.count(), 0); assert.equal(await prisma.claimLine.count(), 0);
  assert.equal((await post(s, claim({ lines: [line({ amountCents: 1 }), line({ amountCents: 1000000 })] }))).status, 201);
});

test('AC-3 text, date, category and line-count rules', async () => {
  const s = await signIn('emp');
  const bads: [string, unknown][] = [
    ['purpose', claim({ purpose: '  123456789  ' })], ['title', claim({ title: '   ' })], ['title', claim({ title: 'x'.repeat(121) })],
    ['purpose', claim({ purpose: 'x'.repeat(2001) })], ['description', claim({ lines: [line({ description: '' })] })],
    ['description', claim({ lines: [line({ description: 'x'.repeat(201) })] })], ['lines', claim({ lines: Array.from({ length: 51 }, () => line()) })],
    ['categoryCode', claim({ lines: [line({ categoryCode: 'yacht' })] })], ['date', claim({ lines: [line({ date: '2026-02-30' })] })],
  ];
  for (const [field, body] of bads) {
    const r = await post(s, body);
    assert.equal(r.status, 422, field);
    assert.match(((await r.json()) as J).reason, new RegExp(field));
  }
  assert.equal(await prisma.claim.count(), 0);
  assert.equal((await post(s, claim({ purpose: '1234567890' }))).status, 201);
});

test('AC-4 totals are integer sums', async () => {
  const s = await signIn('emp');
  const total = async (amounts: number[]) => ((await (await post(s, claim({ lines: amounts.map((amountCents) => line({ amountCents })) }))).json()) as J).totalCents;
  assert.equal(await total([1999, 1]), 2000);
  assert.equal(await total(Array(50).fill(1000000)), 50000000);
  assert.equal(await total(Array(50).fill(1)), 50); // story says 100 x 1 cent, but the 50-line cap (AC-3) makes that a 422; 50 is the largest valid case
});

test('AC-5 categories in seed order; overLimit is a flat strict comparison', async () => {
  const s = await signIn('emp');
  const cats = (await (await get(s, '/categories')).json()) as J[];
  assert.deepEqual(cats.map((c) => [c.label, c.limitCents]), [['Travel', 50000], ['Accommodation', 20000], ['Meals', 5000], ['Office supplies', 10000], ['Training', 100000], ['Other', 10000]]);
  assert.equal((await get(null, '/categories')).status, 401);
  const j = (await (await post(s, claim({ lines: [line({ amountCents: 5001 }), line({ amountCents: 5000 })] }))).json()) as J;
  assert.deepEqual(j.lines.map((l: J) => l.overLimit), [true, false]);
});

test('AC-6 list shows only the caller\'s claims, newest first, with paging validation', async () => {
  const e = await signIn('emp'), m = await signIn('mgr');
  const a = (await (await post(e, claim({ title: 'A' }))).json()) as J;
  const b = (await (await post(e, claim({ title: 'B', lines: [line(), line()] }))).json()) as J;
  await post(m, claim({ title: 'mine' }));
  const rows = (await (await get(m, '/claims')).json()) as J[];
  assert.deepEqual(rows.map((r) => r.title), ['mine']);
  const mine = (await (await get(e, '/claims')).json()) as J[];
  assert.deepEqual(mine.map((r) => r.id), [b.id, a.id]);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'lineCount', 'status', 'title', 'totalCents', 'updatedAt']);
  assert.equal(mine[0].lineCount, 2);
  assert.equal((await get(e, '/claims?limit=101')).status, 422);
  assert.equal((await get(e, '/claims?offset=-1')).status, 422);
  assert.equal((await get(e, '/claims?limit=100&offset=1')).status, 200);
  assert.equal((await get(null, '/claims')).status, 401);
});

test('AC-7 migration keeps rows, seeds categories, has no DROP; server-owned fields; 413; log line', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = readdirSync('prisma/migrations').find((d) => d.endsWith('_claims'))!;
  assert.doesNotMatch(readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8'), /\bDROP\b/i);
  assert.equal(await prisma.category.count(), 6);
  assert.equal(await prisma.user.count(), 3);

  const s = await signIn('emp');
  const r = await post(s, { ...claim({ title: 'Secret title', purpose: 'Secret purpose text', lines: [line({ description: 'Secret desc' })] }), id: 'x', status: 'paid', claimantId: 'mgr', approverId: 'mgr', limitCents: 1 });
  const j = (await r.json()) as J;
  assert.equal(r.status, 201);
  assert.notEqual(j.id, 'x'); assert.equal(j.status, 'draft'); assert.equal(j.claimantId, 'emp'); assert.equal(j.approverId, null);
  assert.equal(j.lines[0].limitCents, null);
  const logged = out.map((l) => JSON.parse(l)).find((l) => l.claimEvent === 'claim_created');
  assert.equal(logged.claimId, j.id);
  assert.doesNotMatch(out.join('\n'), /Secret/);

  const big = await post(s, null, JSON.stringify({ title: 'x'.repeat(150_000) }));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'bad_request' });
});
