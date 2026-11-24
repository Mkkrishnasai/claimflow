import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { HEADER } from '../../api/src/claims/export.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
let tick = 0;
let logs: string[] = [];
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
const seed = async () => {
  await wipe();
  logs = [];
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'mgr', 'fin', 'adm'].map((id) => ({ id, email: `${id}@claimflow.test`, name: `Name ${id}`, role: ({ emp: 'employee', mgr: 'manager', fin: 'finance', adm: 'admin' } as const)[id as 'emp'], passwordHash })) });
};
before(async () => {
  srv = createApp({ log: createLogger({ write: (l: string) => { logs.push(l); return true; } }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] },
    body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }),
  });
  return r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
}
const exp = (cookie: string | null, q: string) => fetch(`${base}/api/exports/paid-claims.csv?${q}`, { headers: cookie ? { cookie } : {} });
const R = 'from=2026-03-01&to=2026-03-15';

// Lines are created while draft (a paid claim refuses inserts), then the status moves.
const mk = async (status: string, paymentDate = '2026-03-01', amounts = [1000], ref = 'INV-1', claimantId = 'emp') => {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const c = await prisma.claim.create({ data: { claimantId, title: `t${tick}`, purpose: 'purpose text', status: 'draft', createdAt: at, updatedAt: at, lines: { create: amounts.map((a, i) => ({ position: i + 1, date: '2026-03-01', categoryCode: 'meals', amountCents: a, description: 'x' })) } } });
  return prisma.claim.update({ where: { id: c.id }, data: { status: status as never, ...(status === 'paid' ? { paymentDate, paymentReference: ref } : {}) } });
};
const body = async (r: Response) => (await r.text()).split('\r\n').filter(Boolean);

test('AC-1 range inclusive at both ends; only paid claims appear', async () => {
  const a = await mk('paid', '2026-03-01'), b = await mk('paid', '2026-03-15'), c = await mk('paid', '2026-04-01');
  for (const s of ['ready_to_pay', 'rejected', 'submitted', 'draft']) await mk(s);
  const r = await exp(await signIn('fin'), R);
  assert.equal(r.status, 200);
  const rows = (await body(r)).slice(1).map((l) => l.split(',')[0]);
  assert.deepEqual(rows, [a.id, b.id]);
  assert.ok(!rows.includes(c.id));
});

test('AC-2 empty range gives 200 with the header row only', async () => {
  await mk('paid', '2026-03-01');
  const r = await exp(await signIn('fin'), 'from=2026-05-01&to=2026-05-31');
  assert.equal(r.status, 200);
  assert.deepEqual(await body(r), [HEADER]);
});

test('AC-3 employee (claimant), manager, admin 403 without CSV; anonymous 401', async () => {
  await mk('paid');
  for (const u of ['emp', 'mgr', 'adm']) {
    const r = await exp(await signIn(u), R);
    assert.equal(r.status, 403, u);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal((await exp(null, R)).status, 401);
});

test('AC-4 invalid ranges 422 invalid_input; from = to is valid', async () => {
  const s = await signIn('fin');
  for (const q of ['to=2026-03-01', 'from=2026-03-01', 'from=2026-02-30&to=2026-03-01', 'from=03/01/2026&to=2026-03-15', 'from=2026-03-15&to=2026-03-01']) {
    const r = await exp(s, q);
    assert.equal(r.status, 422, q);
    assert.equal(((await r.json()) as { error: string }).error, 'invalid_input');
  }
  assert.equal((await exp(s, 'from=2026-03-15&to=2026-03-15')).status, 200);
});

test('AC-5 headers exact and nothing written', async () => {
  await mk('paid');
  const s = await signIn('fin');
  const count = async () => [await prisma.claim.count(), await prisma.claimLine.count(), await prisma.claimEvent.count()];
  const before = await count();
  const r = await exp(s, R);
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="paid-claims-2026-03-01-to-2026-03-15.csv"');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  await r.text();
  assert.deepEqual(await count(), before);
});

test('AC-6 one log line with export fields and no name or reference', async () => {
  await mk('paid', '2026-03-01', [100, 200, 300], 'INV-0042');
  const r = await exp(await signIn('fin'), R);
  assert.equal((await body(r)).length, 4);
  await new Promise((x) => setTimeout(x, 50));
  const lines = logs.filter((l) => l.includes('paid_claims'));
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.export, 'paid_claims'); assert.equal(j.from, '2026-03-01'); assert.equal(j.to, '2026-03-15'); assert.equal(j.rows, 3);
  assert.ok(logs.every((l) => !l.includes('Name emp') && !l.includes('INV-0042')));
  const bad = await exp(await signIn('fin'), 'from=x');
  assert.ok(!(await bad.text()).includes('INV-0042'));
});

test('AC-8 deactivated claimant still exports with name', async () => {
  await mk('paid');
  await prisma.user.update({ where: { id: 'emp' }, data: { active: false } });
  const r = await exp(await signIn('fin'), R);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('Name emp'));
});
