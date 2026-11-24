import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { withWrite } from '../../api/src/db.js';
import { ACTIONS, moveClaim, TRANSITIONS } from '../../api/src/claims/status.js';
import { submitClaim, withdrawClaim } from '../../api/src/claims/service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptStorage } from '../../api/src/claims/receipt-storage.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
const out: string[] = [];
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function seed() {
  await wipe();
  const hash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, managerId: string | null = null, active = true) => ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, active, passwordHash: hash });
  await prisma.user.createMany({ data: [u('mgr', 'manager'), u('emp', 'employee', 'mgr'), u('fin', 'finance'), u('adm', 'admin'), u('lone', 'employee'), u('imgr', 'manager', null, false), u('orph', 'employee', 'imgr')] });
  out.length = 0;
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock, mailer: { async linkMail() {}, async reassignedMail() {} } as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
beforeEach(seed);
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

type S = { cookie: string; csrf: string };
async function signIn(id: string): Promise<S> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }) });
  const b = (await r.json()) as { csrfToken: string };
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: b.csrfToken };
}
const act = (s: S | null, id: string, what: 'submit' | 'withdraw', body: unknown = {}) =>
  fetch(`${base}/api/claims/${id}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}) }, body: JSON.stringify(body) });
type J = Record<string, any>;
let n = 0;
const mk = async (status: string, claimantId = 'emp', lines = 1) => { // lines first: the paid triggers refuse lines on a paid claim
  const c = await prisma.claim.create({ data: { id: `c${++n}`, claimantId, title: 'Secret title', purpose: 'Secret purpose text', status: 'draft', createdAt: new Date(0), updatedAt: new Date(0), lines: { create: Array.from({ length: lines }, (_, i) => ({ position: i + 1, date: '2025-12-25', categoryCode: 'meals', amountCents: 1000, description: 'x' })) } } });
  return status === 'draft' ? c : prisma.claim.update({ where: { id: c.id }, data: { status: status as never, ...(status === 'paid' ? { paymentDate: '2026-11-24', paymentReference: 'INV-0042' } : {}) } });
};
const events = (claimId: string) => prisma.claimEvent.findMany({ where: { claimId }, orderBy: { seq: 'asc' } });
const move = (claimId: string, action: (typeof ACTIONS)[number], reason?: string) => withWrite(prisma, (tx) => moveClaim(tx, { claimId, action, actorId: 'emp', reason, now: new Date(0), ...(action === 'pay' ? { set: { paymentDate: '2026-11-24', paymentReference: 'INV-0042' } } : {}) }));

test('AC-1 all 60 action x status combinations: exactly the table rows succeed, 50 give 409 with 0 rows changed', async () => {
  let ok = 0;
  for (const status of ['draft', 'submitted', 'approved', 'rejected', 'ready_to_pay', 'paid']) {
    for (const action of ACTIONS) {
      const c = await mk(status);
      if (TRANSITIONS[action].from === status) {
        await move(c.id, action, 'long enough reason'); ok++;
        assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).status, TRANSITIONS[action].to);
      } else {
        await assert.rejects(move(c.id, action, 'long enough reason'), { status: 409, code: 'invalid_transition' });
        assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).status, status);
        assert.equal((await events(c.id)).length, 0);
      }
    }
  }
  assert.equal(ok, 10);
});

test('AC-2 submit draft and rejected: snapshot, approver, history, log line without title', async () => {
  const s = await signIn('emp');
  await prisma.category.update({ where: { code: 'meals' }, data: { limitCents: 4242 } });
  try { for (const [status, action] of [['draft', 'submit'], ['rejected', 'resubmit']]) {
    const c = await mk(status);
    out.length = 0;
    const r = await act(s, c.id, 'submit');
    assert.equal(r.status, 200);
    const j = (await r.json()) as J;
    assert.equal(j.status, 'submitted'); assert.equal(j.approverId, 'mgr'); assert.ok(j.submittedAt); assert.equal(j.lines[0].limitCents, 4242);
    const ev = await events(c.id);
    assert.deepEqual(ev.map((e) => [e.action, e.fromStatus, e.toStatus, e.actorId]), [[action, status, 'submitted', 'emp']]);
    const line = out.find((l) => l.includes(c.id) && l.includes('claimEvent'))!;
    assert.match(line, new RegExp(`"claimEvent":"${action}"`)); assert.ok(!line.includes('Secret'));
  } } finally { await prisma.category.update({ where: { code: 'meals' }, data: { limitCents: 5000 } }); }
});

test('AC-3 submit refusals change nothing', async () => {
  const cases: [string, string, number, string, number?][] = [['lone', 'draft', 409, 'no_manager'], ['orph', 'draft', 409, 'manager_inactive'], ['emp', 'draft', 422, 'validation_failed', 0]];
  for (const [user, status, code, err, lines] of cases) {
    const c = await mk(status, user, lines ?? 1);
    const r = await act(await signIn(user), c.id, 'submit');
    assert.equal(r.status, code);
    const j = (await r.json()) as J;
    assert.equal(j.error, err);
    if (err === 'no_manager') assert.equal(j.reason, 'A user with no manager cannot submit claims');
    assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).status, 'draft');
    assert.equal((await events(c.id)).length, 0);
  }
});

test('AC-4 two concurrent submits: one 200, one 409, one history row', async () => {
  const s = await signIn('emp');
  const c = await mk('draft');
  const rs = await Promise.all([act(s, c.id, 'submit'), act(s, c.id, 'submit')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const bad = rs.find((r) => r.status === 409)!;
  assert.equal(((await bad.json()) as J).error, 'invalid_transition');
  assert.equal((await events(c.id)).length, 1);
});

test('AC-5 withdraw returns to draft; other statuses refused and write nothing', async () => {
  const s = await signIn('emp');
  const c = await mk('submitted');
  await prisma.claim.update({ where: { id: c.id }, data: { approverId: 'mgr', submittedAt: new Date(1) } });
  assert.equal((await act(s, c.id, 'withdraw', { reason: 'x'.repeat(501) })).status, 422);
  const r = await act(s, c.id, 'withdraw', { reason: 'wrong receipt' });
  assert.equal(r.status, 200);
  const j = (await r.json()) as J;
  assert.equal(j.status, 'draft'); assert.equal(j.approverId, null); assert.equal(j.submittedAt, null);
  const ev = await events(c.id);
  assert.deepEqual(ev.map((e) => [e.action, e.fromStatus, e.toStatus, e.reason]), [['withdrawn', 'submitted', 'draft', 'wrong receipt']]);
  for (const [st, err] of [['draft', 'invalid_transition'], ['approved', 'invalid_transition'], ['rejected', 'invalid_transition'], ['paid', 'claim_paid']]) {
    const o = await mk(st);
    const x = await act(s, o.id, 'withdraw');
    assert.equal(x.status, 409); assert.equal(((await x.json()) as J).error, err);
    assert.equal((await events(o.id)).length, 0);
  }
});

test('AC-6 only the claimant moves a claim; body status ignored', async () => {
  const d = await mk('draft'), sub = await mk('submitted');
  for (const u of ['mgr', 'fin', 'adm']) {
    const s = await signIn(u);
    assert.equal((await act(s, d.id, 'submit')).status, 403);
    assert.equal((await act(s, sub.id, 'withdraw')).status, 403);
  }
  assert.equal((await act(null, d.id, 'submit')).status, 401);
  assert.equal((await act(null, sub.id, 'withdraw')).status, 401);
  assert.equal((await act(await signIn('emp'), d.id, 'submit', { status: 'paid' })).status, 200);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: d.id } })).status, 'submitted');
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: sub.id } })).status, 'submitted');
  assert.equal((await events(sub.id)).length, 0);
});

test('AC-7 moveClaim: 404, reason rules, no history on refusal', async () => {
  await assert.rejects(move('nope', 'approve_first'), { status: 404 });
  for (const action of ['reject', 'reject_second', 'send_back'] as const) {
    const c = await mk(TRANSITIONS[action].from);
    for (const reason of [undefined, '   short   ', '123456789']) await assert.rejects(move(c.id, action, reason), { status: 422, code: 'reason_required' });
    assert.equal((await events(c.id)).length, 0);
  }
  const c = await mk('submitted');
  await move(c.id, 'approve_first');
  assert.equal((await events(c.id)).length, 1);
  await assert.rejects(move(c.id, 'approve_first'), { status: 409, code: 'invalid_transition' });
  assert.equal((await events(c.id)).length, 1);
});

test('AC-8 20 claims moved concurrently keep seq gapless; a failed insert rolls the status back', async () => {
  const cs = await Promise.all(Array.from({ length: 20 }, () => mk('submitted')));
  const chain: (typeof ACTIONS)[number][] = ['approve_first', 'approve_second', 'send_back', 'resubmit', 'approve_final', 'pay'];
  let okMoves = 0;
  await Promise.all(cs.flatMap((c) => chain.map(async (a) => { try { await move(c.id, a, 'long enough reason'); okMoves++; } catch { /* out-of-order moves refused */ } })));
  let total = 0;
  for (const c of cs) { const ev = await events(c.id); total += ev.length; assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1)); }
  assert.equal(total, okMoves);

  const c = await mk('draft');
  const deps = { prisma, clock, receipts: receiptStorage(mkdtempSync(join(tmpdir(), 'r-'))), beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(submitClaim(deps, { id: 'emp', role: 'employee' }, c.id), /boom/);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).status, 'draft');
  assert.equal((await events(c.id)).length, 0);
  const sc = await mk('submitted');
  await assert.rejects(withdrawClaim(deps, { id: 'emp', role: 'employee' }, sc.id, {}), /boom/);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: sc.id } })).status, 'submitted');
});

test('CLAIM-6 S1 AC-4 pay stores payment fields from set', async () => {
  const c = await mk('ready_to_pay');
  await move(c.id, 'pay');
  const r = await prisma.claim.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual([r.status, r.paymentDate, r.paymentReference], ['paid', '2026-11-24', 'INV-0042']);
});
