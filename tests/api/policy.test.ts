import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { updatePolicy } from '../../api/src/policy/service.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
type S = { cookie: string; csrf: string };
const sessions: Record<string, S> = {};
const logs: string[] = [];
const ROLES = ['employee', 'manager', 'finance', 'admin'] as const;

async function signIn(email: string): Promise<S> {
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
const get = (s: S | null, path: string) => fetch(`${base}${path}`, { headers: s ? { cookie: s.cookie } : {} });

before(async () => {
  const passwordHash = await bcrypt.hash(PW, 4);
  for (const r of ROLES) await prisma.user.create({ data: { id: `pol-${r}`, email: `pol-${r}@claimflow.test`, name: r, role: r, passwordHash } });
  srv = createApp({ log: createLogger({ write: (l: string) => { logs.push(l); return true; } }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  for (const r of ROLES) sessions[r] = await signIn(`pol-${r}@claimflow.test`);
});
after(async () => {
  srv.close();
  await prisma.session.deleteMany({ where: { userId: { startsWith: 'pol-' } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: 'pol-' } } });
  await prisma.$disconnect();
});

test('S2 AC-1: finance reads the six categories and both thresholds', async () => {
  const r = await get(sessions.finance, '/api/policy');
  assert.equal(r.status, 200);
  const b = (await r.json()) as { categories: { label: string; limitCents: number }[]; receiptThresholdCents: number; secondApprovalCents: number };
  assert.deepEqual(b.categories.map((c) => [c.label, c.limitCents]), [['Travel', 50000], ['Accommodation', 20000], ['Meals', 5000], ['Office supplies', 10000], ['Training', 100000], ['Other', 10000]]);
  assert.equal(b.receiptThresholdCents, 2500);
  assert.equal(b.secondApprovalCents, 200000);
});

test('S2 AC-2/AC-3: employee, manager, admin get 403 forbidden; anonymous 401', async () => {
  for (const role of ['employee', 'manager', 'admin']) {
    const r = await get(sessions[role], '/api/policy');
    assert.equal(r.status, 403, role);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal((await get(null, '/api/policy')).status, 401);
});

test('S2 AC-4: missing Policy row is 500 internal_error, no default', async () => {
  const row = await prisma.policy.findUniqueOrThrow({ where: { id: 1 } });
  await prisma.$executeRawUnsafe('DROP TRIGGER "policy_no_delete"');
  await prisma.$executeRawUnsafe('DROP TRIGGER "policy_no_insert"');
  try {
    await prisma.$executeRawUnsafe('DELETE FROM "Policy"');
    const r = await get(sessions.finance, '/api/policy');
    assert.equal(r.status, 500);
    const b = (await r.json()) as Record<string, unknown>;
    assert.equal(b.error, 'internal_error');
    assert.equal(b.receiptThresholdCents, undefined);
  } finally {
    await prisma.$executeRawUnsafe(`INSERT INTO "Policy" (id, receiptThresholdCents, secondApprovalCents) VALUES (1, ${row.receiptThresholdCents}, ${row.secondApprovalCents})`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "policy_no_insert" BEFORE INSERT ON "Policy" BEGIN SELECT RAISE(ABORT, 'policy_no_insert'); END`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "policy_no_delete" BEFORE DELETE ON "Policy" BEGIN SELECT RAISE(ABORT, 'policy_no_delete'); END`);
  }
});

test('S2 AC-5: GET /categories still readable by an employee', async () => {
  assert.equal((await get(sessions.employee, '/api/categories')).status, 200);
});

const patch = (s: S | null, body: unknown, csrf: string | null = s?.csrf ?? null) =>
  fetch(`${base}/api/policy`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify(body) });
const snap = async () => (await get(sessions.finance, '/api/policy')).json() as Promise<{ categories: { code: string; limitCents: number }[]; receiptThresholdCents: number; secondApprovalCents: number }>;
const orig = { limits: { travel: 50000, accommodation: 20000, meals: 5000, office_supplies: 10000, training: 100000, other: 10000 } as Record<string, number>, receiptThresholdCents: 2500, secondApprovalCents: 200000 };
const reset = async () => {
  for (const [code, limitCents] of Object.entries(orig.limits)) await prisma.category.update({ where: { code }, data: { limitCents } });
  await prisma.policy.update({ where: { id: 1 }, data: { receiptThresholdCents: orig.receiptThresholdCents, secondApprovalCents: orig.secondApprovalCents } });
};
const meals = async () => (await snap()).categories.find((c) => c.code === 'meals')!.limitCents;

test('S3 AC-1: finance updates several values; others unchanged', async () => {
  const before = await snap();
  const r = await patch(sessions.finance, { categoryLimits: { meals: 6000 }, receiptThresholdCents: 3000, secondApprovalCents: 250000 });
  assert.equal(r.status, 200);
  const after = await snap();
  assert.deepEqual(await r.json(), after);
  assert.equal(after.receiptThresholdCents, 3000);
  assert.equal(after.secondApprovalCents, 250000);
  assert.deepEqual(after.categories.map((c) => [c.code, c.limitCents]), before.categories.map((c) => [c.code, c.code === 'meals' ? 6000 : c.limitCents]));
  await reset();
});

test('S3 AC-2: non-finance 403, anonymous 401, no CSRF refused, nothing changes', async () => {
  const before = await snap();
  for (const role of ['employee', 'manager', 'admin']) {
    const r = await patch(sessions[role], { receiptThresholdCents: 3000 });
    assert.equal(r.status, 403, role);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal((await patch(null, { receiptThresholdCents: 3000 })).status, 401);
  assert.equal((await patch(sessions.finance, { receiptThresholdCents: 3000 }, null)).status, 403);
  assert.deepEqual(await snap(), before);
});

test('S3 AC-3: invalid bodies are 422 invalid_input with no change; boundary and no-op bodies are 200', async () => {
  const before = await snap();
  const bodies: unknown[] = [
    { receiptThresholdCents: 0 }, { receiptThresholdCents: -1 }, { receiptThresholdCents: 1000001 }, { receiptThresholdCents: 12.5 },
    { receiptThresholdCents: '6000' }, { receiptThresholdCents: null }, { secondApprovalCents: 0 }, { categoryLimits: { meals: null } },
    { categoryLimits: { FOO: 100 } }, { categoryLimits: [] }, { categoryLimits: null }, {}, { colour: 'red' }, [],
  ];
  for (const b of bodies) {
    const r = await patch(sessions.finance, b);
    assert.equal(r.status, 422, JSON.stringify(b));
    assert.equal(((await r.json()) as { error: string }).error, 'invalid_input');
  }
  assert.deepEqual(await snap(), before);
  assert.equal((await patch(sessions.finance, { receiptThresholdCents: 1000000 })).status, 200);
  assert.equal((await patch(sessions.finance, { categoryLimits: Object.fromEntries(before.categories.map((c) => [c.code, c.limitCents])), receiptThresholdCents: 1000000, secondApprovalCents: before.secondApprovalCents })).status, 200);
  await reset();
});

test('S3 AC-4: mixed valid/invalid is rejected whole; injected failure leaves the old policy', async () => {
  assert.equal(await meals(), 5000);
  assert.equal((await patch(sessions.finance, { categoryLimits: { meals: 6000, travel: 0 } })).status, 422);
  assert.equal(await meals(), 5000);
  const before = await snap();
  await assert.rejects(updatePolicy({ prisma, clock: () => new Date(), receipts: {} as never, beforeLastWrite: () => { throw new Error('boom'); } }, { categoryLimits: { meals: 6000 }, receiptThresholdCents: 3000 }));
  assert.deepEqual(await snap(), before);
});

test('S3 AC-5: one log line with policyEvent and changed; no session or user data', async () => {
  logs.length = 0;
  const r = await patch(sessions.finance, { categoryLimits: { meals: 6000 }, receiptThresholdCents: 3000 });
  const body = await r.text();
  await new Promise((res) => setTimeout(res, 50));
  const lines = logs.filter((l) => l.includes('policy_updated'));
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.policyEvent, 'policy_updated');
  assert.deepEqual(rec.changed, ['categoryLimits.meals', 'receiptThresholdCents']);
  for (const t of [lines[0], body]) for (const x of ['pol-finance', 'claimflow.test', sessions.finance.cookie.split('=')[1], sessions.finance.csrf]) assert.ok(!t.includes(x), x);
  await reset();
});
