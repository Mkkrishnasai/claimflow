import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { withWrite } from '../../api/src/db.js';
import { appendEvent, moveClaim, type Action } from '../../api/src/claims/status.js';

// CLAIM-8-S2: moveClaim queues one claimant notification row with the history row.
const PW = 'correct horse battery';
const queries: string[] = [];
const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
(prisma as any).$on('query', (e: { query: string }) => queries.push(e.query));
let srv: Server, base: string;
const logs: string[] = [];
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.notification.deleteMany(); await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
const seed = async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'mgr', 'fin', 'adm'].map((id) => ({ id, email: `${id}@claimflow.test`, name: `N-${id}`, role: ({ emp: 'employee', mgr: 'manager', fin: 'finance', adm: 'admin' } as const)[id as 'emp'], passwordHash })) });
};
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (l: string) => { logs.push(l); return true; } }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

type H = Record<string, string>;
const login = async (who: string): Promise<H> => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${who}@claimflow.test`, password: PW }) });
  return { 'content-type': 'application/json', cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], 'x-csrf-token': ((await r.json()) as { csrfToken: string }).csrfToken };
};
const act = async (who: string, id: string, verb: string, body: unknown = {}) => fetch(`${base}/api/claims/${id}/${verb}`, { method: 'POST', headers: await login(who), body: JSON.stringify(body) });

let n = 0;
const mk = (status: string) => prisma.claim.create({ data: { claimantId: 'emp', title: `t${++n}`, purpose: 'purpose text', status: status as never, approverId: 'mgr', createdAt: new Date(), updatedAt: new Date(), submittedAt: new Date(),
  lines: { create: [{ position: 1, date: '2026-01-01', categoryCode: 'meals', amountCents: 1000, description: 'd', limitCents: 5000 }] } } });
const rows = (claimId?: string) => prisma.notification.findMany({ where: claimId ? { claimId } : {} });
const REASON = 'a long enough reason';
const move = (claimId: string, action: Action, extra: { beforeAppend?: () => void } = {}) =>
  withWrite(prisma, (tx) => moveClaim(tx, { claimId, action, actorId: 'mgr', reason: REASON, now: new Date(), ...(action === 'pay' ? { set: { paymentDate: '2026-01-15', paymentReference: 'INV-1' } } : {}), ...extra }));

test('AC-1 six mail-worthy moves each queue one pending row for the claimant', async () => {
  const cases: [Action, string, string][] = [['approve_final', 'submitted', 'approved'], ['approve_second', 'approved', 'approved'], ['reject', 'submitted', 'rejected'], ['reject_second', 'approved', 'rejected'], ['send_back', 'ready_to_pay', 'sent_back'], ['pay', 'ready_to_pay', 'paid']];
  for (const [action, from, kind] of cases) {
    const c = await mk(from);
    await move(c.id, action);
    const [r, ...rest] = await rows(c.id);
    assert.equal(rest.length, 0, action);
    const ev = await prisma.claimEvent.findFirstOrThrow({ where: { claimId: c.id } });
    assert.deepEqual([r.kind, r.userId, r.status, r.attempts, r.eventSeq, r.dedupeKey], [kind, 'emp', 'pending', 0, ev.seq, `claim:${ev.id}`], action);
    assert.equal(r.nextAttemptAt.getTime(), r.createdAt.getTime());
  }
});

test('AC-2 submit, resubmit, withdraw, approve_first and reassign queue nothing', async () => {
  for (const [action, from] of [['submit', 'draft'], ['resubmit', 'rejected'], ['withdraw', 'submitted'], ['approve_first', 'submitted']] as const) await move((await mk(from)).id, action);
  const c = await mk('submitted');
  await withWrite(prisma, (tx) => appendEvent(tx, { claimId: c.id, actorId: 'adm', action: 'reassigned', fromStatus: 'submitted', toStatus: 'submitted', at: new Date() }));
  assert.equal((await rows()).length, 0);
});

test('AC-3 refused (409, 422, 403) and rolled-back moves queue nothing', async () => {
  const wrong = await mk('draft');
  await assert.rejects(move(wrong.id, 'approve_final'), { status: 409 });
  const rej = await mk('submitted');
  await assert.rejects(withWrite(prisma, (tx) => moveClaim(tx, { claimId: rej.id, action: 'reject', actorId: 'mgr', reason: 'short', now: new Date() })), { status: 422 });
  const forbidden = await mk('submitted');
  assert.equal((await act('emp', forbidden.id, 'approve')).status, 403);
  const boom = await mk('submitted');
  await assert.rejects(move(boom.id, 'approve_final', { beforeAppend: () => { throw new Error('boom'); } }), /boom/);
  assert.equal((await prisma.claimEvent.count({ where: { claimId: boom.id } })), 0);
  assert.equal((await rows()).length, 0);
});

test('AC-4 repeated approval returns 409 and leaves one row for the history row', async () => {
  const c = await mk('submitted');
  assert.equal((await act('mgr', c.id, 'approve')).status, 200);
  assert.equal((await act('mgr', c.id, 'approve')).status, 409);
  const ev = await prisma.claimEvent.findMany({ where: { claimId: c.id } });
  assert.deepEqual((await rows(c.id)).map((r) => r.dedupeKey), [`claim:${ev[0].id}`]);
  await assert.rejects(prisma.notification.create({ data: { kind: 'approved', userId: 'emp', claimId: c.id, dedupeKey: `claim:${ev[0].id}`, nextAttemptAt: new Date() } }), /Unique/);
});

test('AC-5 approve and pay responses carry no notification field; one extra insert, no extra read', async () => {
  const a = await mk('submitted');
  queries.length = 0;
  const r = await act('mgr', a.id, 'approve');
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(JSON.stringify(body).toLowerCase().includes('notification'), false);
  const nq = queries.filter((q) => /Notification/.test(q));
  assert.equal(nq.length, 1); assert.match(nq[0], /^INSERT/);
  const p = await mk('ready_to_pay');
  await prisma.claimEvent.createMany({ data: [['submit', 'draft', 'submitted'], ['approve_final', 'submitted', 'ready_to_pay']].map(([action, fromStatus, toStatus], i) => ({ claimId: p.id, actorId: 'mgr', action, fromStatus, toStatus, seq: i + 1, at: new Date() })) as never });
  const pr = await act('fin', p.id, 'pay', { paymentDate: '2026-01-15', reference: 'INV-1' });
  assert.equal(pr.status, 200);
  assert.equal(JSON.stringify(await pr.json()).toLowerCase().includes('notification'), false);
  assert.deepEqual((await rows(p.id)).map((x) => [x.kind, x.eventSeq]), [['paid', 3]]);
  assert.ok(logs.map((l) => JSON.parse(l)).every((l) => !('notification' in l) && !('dedupeKey' in l)));
});
