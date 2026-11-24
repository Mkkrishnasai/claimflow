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
type S = { cookie: string; csrf: string };
const sessions: Record<string, S> = {};
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
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
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
