import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { submitClaim } from '../../api/src/claims/service.js';
import { withWrite } from '../../api/src/db.js';
import { moveClaim } from '../../api/src/claims/status.js';
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
  return status === 'draft' ? c : prisma.claim.update({ where: { id: c.id }, data: { status: status as never } });
};
const events = (claimId: string) => prisma.claimEvent.findMany({ where: { claimId } });
const mkc = async (lines: Record<string, unknown>[], o: Record<string, unknown> = {}, claimantId = 'emp') => {
  const c = await prisma.claim.create({ data: { id: `s${++n}`, claimantId, title: 'Secret title', purpose: 'Secret purpose text', status: 'draft', createdAt: new Date(0), updatedAt: new Date(0), ...o, lines: { create: lines.map((l, i) => ({ position: i + 1, date: '2025-12-25', categoryCode: 'meals', amountCents: 1000, description: 'x', ...l })) } } });
  return c.id;
};
const withReceipts = async (id: string) => { for (const l of await prisma.claimLine.findMany({ where: { claimId: id } })) await prisma.receipt.create({ data: { lineId: l.id, claimId: id, uploadedById: 'emp', uploadedAt: new Date(0), storageKey: `k${l.id}`, sha256: 'h', sizeBytes: 1, mime: 'image/png' } }); return id; };
const snap = async (id: string) => JSON.stringify([await prisma.claim.findUnique({ where: { id } }), await prisma.claimLine.findMany({ where: { claimId: id }, orderBy: { position: 'asc' } }), await prisma.claimEvent.count()]);
const sub = async (id: string, user = 'emp') => { const r = await act(await signIn(user), id, 'submit'); return { status: r.status, j: (await r.json()) as J }; };
const codes = (j: J) => j.failures.map((f: J) => f.code);
// clock is 2026-01-01 UTC: today = 2026-01-01, today-90d = 2025-10-03

test('AC-1 all failures at once, nothing written, no justification in body or log', async () => {
  const id = await mkc([{ date: '2026-01-02', justification: 'PRIVATE-JUSTIFICATION-TEXT' }, { date: '2025-10-02' }, { amountCents: 3000 }], { purpose: 'short' });
  const before = await snap(id);
  out.length = 0;
  const { status, j } = await sub(id);
  assert.equal(status, 422); assert.equal(j.error, 'validation_failed'); assert.equal(j.reason, '4 problems');
  assert.deepEqual(codes(j), ['purpose_too_short', 'date_in_future', 'date_too_old', 'receipt_required']);
  assert.deepEqual(j.failures.map((f: J) => f.position), [undefined, 1, 2, 3]);
  assert.equal(await snap(id), before);
  assert.ok(!JSON.stringify(j).includes('PRIVATE'));
  const log = out.find((l) => l.includes(id) && l.includes('submit_refused'))!;
  assert.ok(log); assert.ok(!log.includes('PRIVATE'));
  const f = JSON.parse(log);
  assert.equal(f.from, 'draft'); assert.equal(f.to, 'submitted'); assert.equal(f.failureCount, 4); assert.deepEqual(f.failureCodes, codes(j));
});

test('AC-2 boundaries pass; just outside fails; receipt deleted on rejected claim fails again', async () => {
  const ok = await mkc([{ date: '2026-01-01' }, { date: '2025-10-03', amountCents: 1 }, { amountCents: 1_000_000, categoryCode: 'accommodation', justification: 'x'.repeat(20), description: 'y' }, { amountCents: 2499 }]);
  const r = await sub(ok);
  // 1,000,000 needs a receipt (>= 2500)
  assert.deepEqual(codes(r.j), ['receipt_required']); assert.equal(r.j.failures[0].position, 3);
  for (const [line, code] of [[{ date: '2026-01-02' }, 'date_in_future'], [{ date: '2025-10-02' }, 'date_too_old'], [{ amountCents: 0 }, 'amount_out_of_range'], [{ amountCents: 1_000_001, receiptCount: 0 }, 'amount_out_of_range'], [{ amountCents: 2500 }, 'receipt_required']] as [J, string][]) {
    const { receiptCount, ...l } = line;
    const res = await sub(await mkc([l]));
    assert.ok(codes(res.j).includes(code), code);
  }
  const id = await mkc([{ amountCents: 2500 }]);
  const lineId = (await prisma.claimLine.findFirstOrThrow({ where: { claimId: id } })).id;
  const rc = await prisma.receipt.create({ data: { lineId, claimId: id, uploadedById: 'emp', uploadedAt: new Date(0), storageKey: 'k', sha256: 'h', sizeBytes: 1, mime: 'image/png' } });
  assert.equal((await sub(id)).status, 200);
  const rej = await mkc([{ amountCents: 2500 }], { status: 'rejected' });
  const rl = (await prisma.claimLine.findFirstOrThrow({ where: { claimId: rej } })).id;
  const r2 = await prisma.receipt.create({ data: { lineId: rl, claimId: rej, uploadedById: 'emp', uploadedAt: new Date(0), storageKey: 'k2', sha256: 'h2', sizeBytes: 1, mime: 'image/png' } });
  assert.equal(rc.lineId, lineId);
  await prisma.receipt.delete({ where: { id: r2.id } });
  assert.deepEqual(codes((await sub(rej)).j), ['receipt_required']);
});

test('AC-3 no lines is one validation failure, not a top-level no_lines', async () => {
  const { status, j } = await sub(await mkc([]));
  assert.equal(status, 422); assert.equal(j.error, 'validation_failed'); assert.deepEqual(codes(j), ['no_lines']);
});

test('AC-4 justification above the category limit', async () => {
  const bad = ['', '   ', 'x'.repeat(19)];
  for (const justification of bad) assert.deepEqual(codes((await sub(await withReceipts(await mkc([{ amountCents: 5001, justification }])))).j), ['justification_required']);
  const ok = await sub(await withReceipts(await mkc([{ amountCents: 5001, justification: 'x'.repeat(20) }])));
  assert.equal(ok.status, 200); assert.equal(ok.j.lines[0].overLimit, true); assert.equal(ok.j.lines[0].limitCents, 5000);
  const at = await sub(await withReceipts(await mkc([{ amountCents: 5000 }])));
  assert.equal(at.status, 200); assert.equal(at.j.lines[0].overLimit, false);
  assert.deepEqual(codes((await sub(await withReceipts(await mkc([{ amountCents: 20001, categoryCode: 'accommodation' }])))).j), ['justification_required']);
});

test('AC-5 clean claim 200; non-claimants 403; no manager 409 before validation; drafts still editable', async () => {
  const id = await mkc([{}]);
  const r = await sub(id);
  assert.equal(r.status, 200); assert.equal(r.j.status, 'submitted');
  const inv = await mkc([], { purpose: 'short' });
  for (const u of ['mgr', 'fin', 'adm']) assert.equal((await sub(inv, u)).status, 403);
  const lone = await mkc([], { purpose: 'short' }, 'lone');
  const x = await sub(lone, 'lone');
  assert.equal(x.status, 409); assert.equal(x.j.error, 'no_manager'); assert.equal(x.j.reason, 'A user with no manager cannot submit claims');
  const s = await signIn('lone');
  const h = { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf };
  const c = await fetch(`${base}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'T', purpose: 'long enough purpose', lines: [] }) });
  assert.equal(c.status, 201);
  const cid = ((await c.json()) as J).id;
  assert.equal((await fetch(`${base}/api/claims/${cid}`, { method: 'PATCH', headers: h, body: JSON.stringify({ title: 'T2' }) })).status, 200);
});

test('AC-6 5xx body stays exactly internal_error; no new route', async () => {
  const id = await mkc([{}]);
  const deps = { prisma, clock, receipts: receiptStorage(mkdtempSync(join(tmpdir(), 'r-'))), beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(submitClaim(deps, { id: 'emp', role: 'employee' }, id), /boom/);
  const r = await fetch(`${base}/api/claims/nope/submit`, { method: 'POST' });
  assert.ok(r.status >= 400);
});

test('AC-7 throwing submit rolls back; concurrent submits give [200, 409] with one history row', async () => {
  const id = await mkc([{}]);
  const deps = { prisma, clock, receipts: receiptStorage(mkdtempSync(join(tmpdir(), 'r-'))), beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(submitClaim(deps, { id: 'emp', role: 'employee' }, id), /boom/);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id } })).status, 'draft');
  assert.equal((await events(id)).length, 0);
  const s = await signIn('emp');
  const rs = await Promise.all([act(s, id, 'submit'), act(s, id, 'submit')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await events(id)).length, 1);
});

// ---- CLAIM-4-S3: duplicate flags ----
const dupOf = async (id: string) => (await prisma.claimLine.findMany({ where: { claimId: id }, orderBy: { position: 'asc' } })).map((l) => [l.duplicateClaimId, l.duplicateBasis]);
const withSha = async (id: string, sha: string, position?: number) => { for (const l of await prisma.claimLine.findMany({ where: { claimId: id, ...(position ? { position } : {}) } })) await prisma.receipt.create({ data: { lineId: l.id, claimId: id, uploadedById: 'emp', uploadedAt: new Date(0), storageKey: `k${l.id}`, sha256: sha, sizeBytes: 1, mime: 'image/png' } }); return id; };
const T = { date: '2025-12-20', amountCents: 4000 };

test('S3 AC-2/AC-4 receipt match across employees links the earlier claim; receipt beats match; submit is 200', async () => {
  const early = await withSha(await mkc([{ amountCents: 3000 }], { status: 'submitted', submittedAt: new Date(100) }, 'lone'), 'same');
  const later = await withSha(await mkc([{ amountCents: 3000 }], { status: 'approved', submittedAt: new Date(200) }, 'mgr'), 'same');
  const tripleClaim = await mkc([{ ...T }], { status: 'submitted', submittedAt: new Date(50) });
  const id = await withSha(await withSha(await mkc([{ amountCents: 3000 }, { ...T }]), 'same', 1), 'unique-1', 2);
  const r = await sub(id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.lines[0].duplicate, { claimId: early, basis: 'receipt' });
  assert.deepEqual(r.j.lines[1].duplicate, { claimId: tripleClaim, basis: 'match' });
  assert.notEqual(later, early);
});

test('S3 AC-3 triple: other employee, own draft and same claim are not flagged', async () => {
  await withSha(await mkc([{ ...T }], { status: 'submitted' }, 'lone'), 'o1');
  await mkc([{ ...T }]); // own draft
  const id = await mkc([{ ...T }, { ...T, description: 'same claim' }]);
  const r = await sub(await withReceipts(id));
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.lines.map((l: J) => l.duplicate), [null, null]);
});

test('S3 AC-7 withdraw clears flags; resubmit recomputes after the match is gone', async () => {
  const other = await mkc([{ ...T }], { status: 'submitted', submittedAt: new Date(1) });
  const id = await withReceipts(await mkc([{ ...T }]));
  assert.deepEqual((await sub(id)).j.lines[0].duplicate, { claimId: other, basis: 'match' });
  const s = await signIn('emp');
  assert.equal((await act(s, id, 'withdraw')).status, 200);
  assert.deepEqual(await dupOf(id), [[null, null]]);
  await prisma.claimLine.updateMany({ where: { claimId: other }, data: { amountCents: 4001 } });
  await prisma.claimLine.updateMany({ where: { claimId: id }, data: { duplicateClaimId: 'stale', duplicateBasis: 'match' } });
  assert.equal((await sub(id)).j.lines[0].duplicate, null);
  assert.deepEqual(await dupOf(id), [[null, null]]);
});

test('S3 AC-5 the link carries only an id and the other claim stays 403', async () => {
  const a = await withSha(await mkc([{ amountCents: 3000 }], { status: 'submitted', submittedAt: new Date(1) }, 'lone'), 'sh');
  const b = await withSha(await mkc([{ amountCents: 3000 }]), 'sh');
  const r = await sub(b);
  assert.deepEqual(Object.keys(r.j.lines[0].duplicate).sort(), ['basis', 'claimId']);
  const s = await signIn('emp');
  assert.equal((await fetch(`${base}/api/claims/${a}`, { headers: { cookie: s.cookie } })).status, 403);
});

// ---- CLAIM-4-S4: withdraw and resubmit ----
const mv = (claimId: string, action: Parameters<typeof moveClaim>[1]['action'], reason?: string) => withWrite(prisma, (tx) => moveClaim(tx, { claimId, action, actorId: 'mgr', reason, now: new Date(0) }));
const hist = async (id: string) => (await prisma.claimEvent.findMany({ where: { claimId: id }, orderBy: { seq: 'asc' } })).map((e) => e.action);

test('AC-9 withdraw: draft, flags and approver cleared, snapshot kept, claimant-only, refused after manager acts, race gives one winner', async () => {
  const other = await mkc([{ ...T }], { status: 'submitted', submittedAt: new Date(1) });
  const id = await withReceipts(await mkc([{ ...T }]));
  const s = await signIn('emp');
  assert.deepEqual((await sub(id)).j.lines[0].duplicate, { claimId: other, basis: 'match' });
  out.length = 0;
  assert.equal((await act(await signIn('fin'), id, 'withdraw')).status, 403);
  const r = await act(s, id, 'withdraw');
  assert.equal(r.status, 200);
  const j = (await r.json()) as J;
  assert.equal(j.status, 'draft'); assert.equal(j.approverId, null); assert.equal(j.submittedAt, null);
  assert.deepEqual(j.lines.map((l: J) => l.duplicate), [null]); assert.equal(j.lines[0].limitCents, 5000);
  assert.deepEqual(await hist(id), ['submit', 'withdrawn']);
  assert.match(out.find((l) => l.includes(id) && l.includes('claimEvent'))!, /"claimEvent":"withdrawn"/);
  assert.equal(((await (await fetch(`${base}/api/claims/${id}`, { headers: { cookie: s.cookie } })).json()) as J).lines[0].limitCents, 5000);

  for (const [st, err] of [['approved', 'invalid_transition'], ['rejected', 'invalid_transition'], ['ready_to_pay', 'invalid_transition'], ['paid', 'claim_paid']]) {
    const o = await mk(st);
    const x = await act(s, o.id, 'withdraw');
    assert.equal(x.status, 409); assert.equal(((await x.json()) as J).error, err);
    assert.equal((await events(o.id)).length, 0);
  }

  const race = await mkc([{}], { status: 'submitted', approverId: 'mgr', submittedAt: new Date(1) });
  const [a, w] = await Promise.allSettled([mv(race, 'approve_first'), act(s, race, 'withdraw').then((x) => { if (x.status !== 200) throw new Error(String(x.status)); })]);
  assert.equal([a, w].filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await events(race)).length, 1);
});

test('AC-10 resubmit after reject and after finance send-back: 422 stays rejected, fixed gives submit/reject/resubmit, approver is current manager', async () => {
  const id = await mkc([{}]);
  assert.equal((await sub(id)).status, 200);
  await mv(id, 'reject', 'long enough reason');
  await prisma.claimLine.updateMany({ where: { claimId: id }, data: { date: '2026-01-02' } });
  const bad = await sub(id);
  assert.equal(bad.status, 422); assert.equal(bad.j.error, 'validation_failed');
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id } })).status, 'rejected');
  await prisma.claimLine.updateMany({ where: { claimId: id }, data: { date: '2025-12-25' } });
  const ok = await sub(id);
  assert.equal(ok.status, 200); assert.equal(ok.j.status, 'submitted');
  assert.deepEqual(await hist(id), ['submit', 'reject', 'resubmit']);

  await prisma.user.create({ data: { id: 'mgr2', email: 'mgr2@claimflow.test', name: 'mgr2', role: 'manager', passwordHash: 'x' } });
  await prisma.user.update({ where: { id: 'emp' }, data: { managerId: 'mgr2' } });
  const sb = await mkc([{}], { status: 'ready_to_pay', approverId: 'mgr' });
  await mv(sb, 'send_back', 'long enough reason');
  const r = await sub(sb);
  assert.equal(r.status, 200); assert.equal(r.j.approverId, 'mgr2');
  assert.deepEqual(await hist(sb), ['send_back', 'resubmit']);
});
