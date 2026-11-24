import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { payClaim } from '../../api/src/claims/service.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
let tick = 0;
const logs: string[] = [];
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
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'mgr', 'fin', 'fin2', 'adm'].map((id) => ({ id, email: `${id}@claimflow.test`, name: `N-${id}`, role: ({ emp: 'employee', mgr: 'manager', fin: 'finance', fin2: 'finance', adm: 'admin' } as const)[id as 'emp'], passwordHash })) });
};
before(async () => {
  await seed();
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
const get = (cookie: string | null, q = '') => fetch(`${base}/api/payments${q}`, { headers: cookie ? { cookie } : {} });
type J = Record<string, any>;

// Lines are created before the status moves: a paid claim refuses inserts.
const mk = async (status: string, amounts: number[] = [1000], line: Record<string, unknown> = {}) => {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const c = await prisma.claim.create({ data: { claimantId: 'emp', title: `t${tick}`, purpose: 'purpose text', status: 'draft', createdAt: at, updatedAt: at, submittedAt: at, lines: { create: amounts.map((a, i) => ({ position: i + 1, date: '2026-03-01', categoryCode: 'meals', amountCents: a, description: 'x', limitCents: 5000, ...line })) } } });
  if (status === 'draft') return c;
  return prisma.claim.update({ where: { id: c.id }, data: { status: status as never, updatedAt: at, ...(status === 'paid' ? { paymentDate: '2026-11-24', paymentReference: 'INV-1' } : {}) } });
};

test('AC-1 finance sees ready_to_pay claims with totals, ordered by updatedAt then id', async () => {
  const a = await mk('ready_to_pay', [12_500]); const b = await mk('ready_to_pay', [5000, 2500]);
  const r = await get(await signIn('fin'));
  assert.equal(r.status, 200);
  const j = (await r.json()) as J;
  assert.equal(j.count, 2); assert.equal(j.totalCents, 20_000);
  assert.deepEqual(j.items.map((i: J) => i.id), [a.id, b.id]);
  assert.deepEqual(Object.keys(j.items[1]).sort(), ['claimant', 'duplicateCount', 'id', 'lineCount', 'overLimitCount', 'readyAt', 'submittedAt', 'title', 'totalCents']);
  assert.deepEqual(j.items[1].claimant, { id: 'emp', name: 'N-emp' });
  assert.equal(j.items[1].totalCents, 7500); assert.equal(j.items[1].lineCount, 2);
});

test('AC-2 only ready_to_pay listed; employee, manager, admin 403; anonymous 401', async () => {
  for (const s of ['draft', 'submitted', 'approved', 'rejected', 'paid']) await mk(s);
  const q = await mk('ready_to_pay');
  const j = (await (await get(await signIn('fin'))).json()) as J;
  assert.deepEqual(j.items.map((i: J) => i.id), [q.id]);
  for (const id of ['emp', 'mgr', 'adm']) {
    const r = await get(await signIn(id));
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden' });
  }
  assert.equal((await get(null)).status, 401);
});

test('AC-3 a paid claim leaves the queue and the totals drop', async () => {
  const a = await mk('ready_to_pay', [1000]); await mk('ready_to_pay', [2000]);
  const fin = await signIn('fin');
  assert.equal(((await (await get(fin)).json()) as J).count, 2);
  await prisma.claim.update({ where: { id: a.id }, data: { status: 'paid', paymentDate: '2026-11-24', paymentReference: 'INV-1' } });
  const j = (await (await get(fin)).json()) as J;
  assert.equal(j.count, 1); assert.equal(j.totalCents, 2000);
});

test('AC-4 limit pages items but not totals; bad paging 422; non-finance 403 first', async () => {
  for (let i = 1; i <= 3; i++) await mk('ready_to_pay', [i * 100]);
  const fin = await signIn('fin');
  const j = (await (await get(fin, '?limit=1')).json()) as J;
  assert.equal(j.items.length, 1); assert.equal(j.count, 3); assert.equal(j.totalCents, 600);
  for (const q of ['?limit=0', '?offset=-1']) {
    const r = await get(fin, q);
    assert.equal(r.status, 422); assert.equal(((await r.json()) as J).error, 'invalid_input');
  }
  assert.equal((await get(await signIn('emp'), '?limit=0')).status, 403);
});

test('AC-5 over-limit and duplicate flags counted; empty queue is zero', async () => {
  const fin = await signIn('fin');
  assert.deepEqual(await (await get(fin)).json(), { count: 0, totalCents: 0, items: [] });
  const over = await mk('ready_to_pay', [5001]);
  const dup = await mk('ready_to_pay', [1000], { duplicateClaimId: over.id, duplicateBasis: 'receipt' });
  const j = (await (await get(fin)).json()) as J;
  const by = (id: string) => j.items.find((i: J) => i.id === id);
  assert.equal(by(over.id).overLimitCount, 1); assert.equal(by(over.id).duplicateCount, 0);
  assert.equal(by(dup.id).duplicateCount, 1); assert.equal(by(dup.id).overLimitCount, 0);
});

// ---- CLAIM-6-S3: pay ----
const TODAY = new Date().toISOString().slice(0, 10);
const OK = { paymentDate: '2026-01-15', reference: 'INV-0042' };
type H = Record<string, string>;
const login = async (who: string, csrf = true): Promise<H> => {
  let h: H = { 'content-type': 'application/json' };
  {
    const pre = await fetch(`${base}/api/auth/csrf`);
    const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
    const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${who}@claimflow.test`, password: PW }) });
    h = { ...h, cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], ...(csrf ? { 'x-csrf-token': ((await r.json()) as J).csrfToken } : {}) };
  }
  return h;
};
const payAs = (h: H, id: string, body: unknown = OK) => fetch(`${base}/api/claims/${id}/pay`, { method: 'POST', headers: h, body: JSON.stringify(body) });
const pay = async (who: string | null, id: string, body: unknown = OK, csrf = true) => payAs(who ? await login(who, csrf) : { 'content-type': 'application/json' }, id, body);
const events = (id: string) => prisma.claimEvent.findMany({ where: { claimId: id, action: 'pay' } });
// Approved history, as the real flow leaves it.
const rtp = async () => {
  const c = await mk('ready_to_pay');
  await prisma.claimEvent.createMany({ data: [['submit', 'draft', 'submitted'], ['approve_final', 'submitted', 'ready_to_pay']].map(([action, fromStatus, toStatus], i) => ({ claimId: c.id, actorId: 'mgr', action, fromStatus, toStatus, seq: i + 1, at: new Date() })) });
  return c;
};
const row = (id: string) => prisma.claim.findUniqueOrThrow({ where: { id } });

test('S3 AC-1 finance pays: 200, payment set, one pay history row, same payment on GET', async () => {
  const c = await rtp();
  const r = await pay('fin', c.id);
  assert.equal(r.status, 200);
  const j = (await r.json()) as J;
  assert.equal(j.status, 'paid'); assert.deepEqual(j.payment, { date: '2026-01-15', reference: 'INV-0042' });
  const ev = await events(c.id);
  assert.deepEqual(ev.map((e) => [e.action, e.actorId]), [['pay', 'fin']]);
  const g = await fetch(`${base}/api/claims/${c.id}`, { headers: { cookie: await signIn('fin') } });
  assert.deepEqual(((await g.json()) as J).payment, j.payment);
  const u = await mk('submitted');
  assert.equal(((await (await fetch(`${base}/api/claims/${u.id}`, { headers: { cookie: await signIn('fin') } })).json()) as J).payment, null);
});

test('S3 AC-2 bad input is 422 and changes nothing; old date and today accepted', async () => {
  const c = await rtp();
  const bads: unknown[] = [
    { paymentDate: '2026-01-15' }, { ...OK, reference: '' }, { ...OK, reference: '   ' }, { ...OK, reference: 'x'.repeat(101) },
    { ...OK, paymentDate: '2026-13-40' }, { ...OK, paymentDate: 20260115 }, { reference: 'R' }, { ...OK, paymentDate: '2999-01-01' }, { ...OK, paymentDate: '2026-02-30' },
  ];
  for (const b of bads) {
    const r = await pay('fin', c.id, b);
    assert.equal(r.status, 422, JSON.stringify(b)); assert.equal(((await r.json()) as J).error, 'invalid_input');
  }
  assert.equal((await row(c.id)).status, 'ready_to_pay'); assert.equal((await events(c.id)).length, 0);
  assert.equal((await pay('fin', c.id, { paymentDate: TODAY, reference: 'R'.repeat(100) })).status, 200);
});

test('S3 AC-3 wrong role 403, unknown 404 first, wrong status 409; 0 rows changed', async () => {
  const c = await rtp();
  for (const who of ['emp', 'mgr', 'adm']) { const r = await pay(who, c.id); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden' }); }
  assert.equal((await pay('emp', 'nope')).status, 404);
  assert.equal((await pay('fin', 'nope')).status, 404);
  for (const s of ['draft', 'submitted', 'approved', 'rejected']) {
    const x = await mk(s); const r = await pay('fin', x.id);
    assert.equal(r.status, 409, s); assert.equal(((await r.json()) as J).error, 'invalid_transition');
    assert.equal((await row(x.id)).paymentReference, null);
  }
  assert.equal((await row(c.id)).status, 'ready_to_pay'); assert.equal((await events(c.id)).length, 0);
});

test('S3 AC-4 failed history insert rolls back; extra body keys ignored', async () => {
  const c = await rtp();
  const deps = { prisma, clock: () => new Date(), receipts: {} as never, beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(payClaim(deps, { id: 'fin', role: 'finance' }, c.id, OK), /boom/);
  const r = await row(c.id);
  assert.deepEqual([r.status, r.paymentDate, r.paymentReference], ['ready_to_pay', null, null]); assert.equal((await events(c.id)).length, 0);
  const res = await pay('fin', c.id, { ...OK, status: 'rejected', claimantId: 'adm', amountCents: 1 });
  assert.equal(res.status, 200);
  const after = await row(c.id);
  assert.deepEqual([after.status, after.claimantId, after.paymentDate, after.paymentReference], ['paid', 'emp', '2026-01-15', 'INV-0042']);
  assert.equal((await prisma.claimLine.findFirstOrThrow({ where: { claimId: c.id } })).amountCents, 1000);
});

test('S3 AC-5 two simultaneous pays: one 200, one 409, one pay row', async () => {
  const c = await rtp();
  const h = await login('fin');
  const rs = await Promise.all([payAs(h, c.id), payAs(h, c.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await events(c.id)).filter((e) => e.action === 'pay').length, 1);
});

test('S3 AC-6 log line has pay fields only; reference never logged or echoed; CSRF 403', async () => {
  const c = await rtp();
  logs.length = 0;
  const bad = await pay('fin', c.id, { paymentDate: 'bad', reference: 'SECRET-REF-123' });
  assert.equal(bad.status, 422); assert.ok(!(await bad.text()).includes('SECRET-REF-123'));
  assert.equal((await pay('fin', c.id, { paymentDate: '2026-01-15', reference: 'SECRET-REF-123' })).status, 200);
  assert.ok(!logs.join('').includes('SECRET-REF-123'));
  const ev = logs.map((l) => JSON.parse(l)).filter((l) => l.claimEvent === 'pay');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].claimId, ev[0].from, ev[0].to], [c.id, 'ready_to_pay', 'paid']);
  const d = await rtp();
  const r = await pay('fin', d.id, OK, false);
  assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'csrf' });
});

test('S4 AC-3 history lacking approvals: 409 approval_missing, nothing written', async () => {
  const c = await mk('ready_to_pay');
  await prisma.claimEvent.create({ data: { claimId: c.id, actorId: 'emp', action: 'submit', fromStatus: 'draft', toStatus: 'submitted', seq: 1, at: new Date() } });
  const r = await pay('fin', c.id);
  assert.equal(r.status, 409); assert.equal(((await r.json()) as J).error, 'approval_missing');
  assert.equal((await row(c.id)).status, 'ready_to_pay'); assert.equal((await prisma.claimEvent.count({ where: { claimId: c.id } })), 1);
});

test('S4 AC-4 second pay: 409 claim_paid, nothing changes', async () => {
  const c = await rtp();
  assert.equal((await pay('fin', c.id)).status, 200);
  const before = [await row(c.id), await prisma.claimEvent.count({ where: { claimId: c.id } })];
  const r = await pay('fin', c.id, { paymentDate: '2026-02-01', reference: 'OTHER' });
  assert.equal(r.status, 409); assert.equal(((await r.json()) as J).error, 'claim_paid');
  assert.deepEqual([await row(c.id), await prisma.claimEvent.count({ where: { claimId: c.id } })], before);
});

test('S4 AC-5 finance cannot pay own claim, even as approver; another finance can', async () => {
  const c = await rtp();
  await prisma.claim.update({ where: { id: c.id }, data: { claimantId: 'fin', approverId: 'fin' } });
  const r = await pay('fin', c.id);
  assert.equal(r.status, 403); assert.equal(((await r.json()) as J).error, 'self_payment');
  assert.equal((await row(c.id)).status, 'ready_to_pay'); assert.equal((await events(c.id)).length, 0);
  assert.equal((await pay('fin2', c.id)).status, 200);
});
