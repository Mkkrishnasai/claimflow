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

// CLAIM-8-S3: dispatcher send path.
import { runOnce } from '../../api/src/notify/dispatcher.js';
const sentMail: { to: string; subject: string; text: string }[] = [];
let fail = false;
const mailer = { notifyMail: async (to: string, subject: string, text: string) => { if (fail) throw new Error('smtp down secret@x.test'); sentMail.push({ to, subject, text }); } } as never;
const dlogs: string[] = [];
const run = () => runOnce({ prisma, clock: () => new Date(Date.now() + 1000), mailer, publicBaseUrl: 'http://app.test', log: createLogger({ write: (l: string) => { dlogs.push(l); return true; } }) });
const mkMoved = async (status: string, action: Action, title = 'Taxi', claimant = 'emp') => {
  const c = await mk(status);
  await prisma.claim.update({ where: { id: c.id }, data: { title, claimantId: claimant } });
  await move(c.id, action);
  return c;
};
beforeEach(() => { sentMail.length = 0; dlogs.length = 0; fail = false; });

test('S3 AC-1 and AC-5 pending row is sent once to the claimant and becomes sent', async () => {
  const c = await mkMoved('submitted', 'approve_final');
  await run(); await run();
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'emp@claimflow.test');
  const [r] = await rows(c.id);
  assert.equal(r.status, 'sent'); assert.ok(r.sentAt);
});

test('S3 AC-2/3/4 content per kind, header injection neutralised, only own claimant, no secrets', async () => {
  await mkMoved('submitted', 'approve_final', 'x\r\nBcc: a@b.test');
  await mkMoved('submitted', 'reject');
  await mkMoved('ready_to_pay', 'send_back', 'Other', 'mgr');
  await run();
  const by = (s: string) => sentMail.find((m) => m.subject === s)!;
  assert.ok(by('Your claim was approved').text.includes('x Bcc: a@b.test\n'));
  assert.ok(by('Your claim was rejected').text.includes(REASON));
  assert.ok(by('Your claim was sent back').text.includes(REASON));
  assert.equal(by('Your claim was sent back').to, 'mgr@claimflow.test');
  assert.equal(by('Your claim was rejected').to, 'emp@claimflow.test');
  for (const m of sentMail) { assert.match(m.text, /EUR 10\.00/); assert.match(m.text, /N-mgr/); assert.doesNotMatch(m.text, /password|token|sid=/i); }
});

test('S3 AC-2 paid body has date and reference', async () => {
  await mkMoved('ready_to_pay', 'pay');
  await run();
  assert.match(sentMail[0].text, /2026-01-15/); assert.match(sentMail[0].text, /INV-1/);
});

test('S3 AC-6 unrenderable row fails without sending, attempts unchanged', async () => {
  const c = await mkMoved('submitted', 'approve_final');
  await prisma.notification.updateMany({ where: { claimId: c.id }, data: { eventSeq: 99 } });
  await run();
  const [r] = await rows(c.id);
  assert.deepEqual([r.status, r.attempts, sentMail.length], ['failed', 0, 0]);
  assert.equal(dlogs.map((l) => JSON.parse(l)).filter((l) => l.mailEvent === 'render_failed').length, 1);
});

test('S3 AC-7 one PII-free sent line; failed send is logged without address', async () => {
  const c = await mkMoved('ready_to_pay', 'pay', 'SecretTitle');
  await run();
  const lines = dlogs.map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].mailEvent, lines[0].kind, lines[0].attempts, typeof lines[0].notificationId], ['sent', 'paid', 0, 'string']);
  for (const s of ['emp@claimflow.test', 'SecretTitle', 'INV-1']) assert.ok(!dlogs.join('').includes(s));
  fail = true; dlogs.length = 0;
  await mkMoved('submitted', 'approve_final');
  await run();
  assert.ok(!dlogs.join('').includes('secret@x.test'));
  assert.equal(JSON.parse(dlogs[0]).mailEvent, 'retry');
  void c;
});

test('S3 AC-8 one run sends 50 of 60 due rows', async () => {
  const c = await mkMoved('submitted', 'approve_final');
  const src = (await rows(c.id))[0];
  await prisma.notification.createMany({ data: Array.from({ length: 59 }, (_, i) => ({ kind: 'approved' as const, userId: 'emp', claimId: c.id, eventSeq: src.eventSeq, dedupeKey: `bulk-${i}`, nextAttemptAt: new Date(0) })) });
  await run();
  assert.equal(sentMail.length, 50);
  assert.equal(await prisma.notification.count({ where: { status: 'pending' } }), 10);
});

// CLAIM-8-S4: back-off, deadline, streak, timeout.
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
let nowMin = 0;
const sends: number[] = [];
let okFrom = Infinity;
let hang = false;
const mailer4 = { notifyMail: async () => { sends.push(nowMin); if (hang) return new Promise(() => {}); if (nowMin < okFrom) throw new Error('down'); } } as never;
const run4 = (sendTimeoutMs?: number) => runOnce({ prisma, clock: () => new Date(T0 + nowMin * MIN), mailer: mailer4, publicBaseUrl: 'http://app.test', sendTimeoutMs, log: createLogger({ write: (l: string) => { dlogs.push(l); return true; } }) });
const mk4 = async (createdMin = 0, attempts = 0, dueMin = createdMin) => {
  const c = await mkMoved('submitted', 'approve_final');
  await prisma.notification.updateMany({ where: { claimId: c.id }, data: { createdAt: new Date(T0 + createdMin * MIN), nextAttemptAt: new Date(T0 + dueMin * MIN), attempts } });
  return c;
};
beforeEach(() => { nowMin = 0; sends.length = 0; okFrom = Infinity; hang = false; });

test('S4 AC-1 back-off schedule to the deadline, then failed and never sent again', async () => {
  const c = await mk4();
  for (nowMin = 0; nowMin <= 140; nowMin++) await run4();
  assert.deepEqual(sends, [0, 1, 3, 7, 15, 30, 45, 60, 75, 90, 105, 120]);
  const [r] = await rows(c.id);
  assert.deepEqual([r.status, r.attempts], ['failed', 12]);
  const ev = dlogs.map((l) => JSON.parse(l).mailEvent);
  assert.deepEqual([ev.filter((e) => e === 'retry').length, ev.at(-1)], [11, 'failed']);
  assert.ok(!dlogs.join('').includes('emp@claimflow.test'));
});

test('S4 AC-2 mailer recovering at minute 100 gets the row sent once', async () => {
  const c = await mk4(); okFrom = 100;
  for (nowMin = 0; nowMin <= 140; nowMin++) await run4();
  assert.deepEqual(sends.slice(-2), [90, 105]);
  assert.equal((await rows(c.id))[0].status, 'sent');
});

test('S4 AC-3 jump to 119 gives a last attempt, 121 fails without a send; expired rows skip the streak', async () => {
  const a = await mk4(0, 1, 1);
  nowMin = 119; await run4();
  assert.deepEqual([sends.length, (await rows(a.id))[0].status], [1, 'failed']);
  sends.length = 0;
  const exp = [await mk4(0, 1, 1), await mk4(0, 1, 2), await mk4(0, 1, 3)];
  const live = await mk4(111, 0, 111);
  nowMin = 121; await run4();
  for (const c of exp) assert.deepEqual([(await rows(c.id))[0].status, (await rows(c.id))[0].attempts], ['failed', 1]);
  assert.equal(sends.length, 1);
  assert.equal((await rows(live.id))[0].attempts, 1);
});

test('S4 AC-4 three failures end the run, the other two rows are untouched', async () => {
  for (let i = 0; i < 5; i++) await mk4();
  await run4();
  const rs = await rows();
  assert.deepEqual([rs.filter((r) => r.attempts === 1).length, rs.filter((r) => r.attempts === 0).length, sends.length], [3, 2, 3]);
});

test('S4 AC-5 hanging mailer is a failure after the timeout and does not block the next run', async () => {
  const c = await mk4(); hang = true;
  await run4(20);
  assert.equal((await rows(c.id))[0].attempts, 1);
  hang = false; okFrom = 0; nowMin = 1;
  await run4(20);
  assert.equal((await rows(c.id))[0].status, 'sent');
});

// CLAIM-8-S5: mail trouble never touches approve or pay.
import { readdirSync, readFileSync } from 'node:fs';
import { createMailer } from '../../api/src/mailer.js';
import { createServer } from 'node:net';
const appWith = async (m: unknown) => {
  const s = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: m as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  return s;
};
const mkPay = async () => {
  const p = await mk('ready_to_pay');
  await prisma.claimEvent.createMany({ data: [['submit', 'draft', 'submitted'], ['approve_final', 'submitted', 'ready_to_pay']].map(([action, fromStatus, toStatus], i) => ({ claimId: p.id, actorId: 'mgr', action, fromStatus, toStatus, seq: i + 1, at: new Date() })) as never });
  return p;
};
// Approve + pay through the HTTP API; returns elapsed ms per call and checks 200, new status, history row, pending rows.
const approveAndPay = async () => {
  const a = await mk('submitted'), p = await mkPay();
  const t0 = Date.now();
  const ra = await act('mgr', a.id, 'approve');
  const ta = Date.now() - t0;
  const t1 = Date.now();
  const rp = await act('fin', p.id, 'pay', { paymentDate: '2026-01-15', reference: 'INV-1' });
  const tp = Date.now() - t1;
  assert.deepEqual([ra.status, rp.status], [200, 200]);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: a.id } })).status, 'ready_to_pay');
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: p.id } })).status, 'paid');
  assert.equal(await prisma.claimEvent.count({ where: { claimId: a.id, action: 'approve_final' } }), 1);
  assert.equal(await prisma.claimEvent.count({ where: { claimId: p.id, action: 'pay' } }), 1);
  return { a, p, ta, tp };
};

test('S5 AC-1 throwing mailer: approve and pay return 200, rows pending', async () => {
  const bad = new Proxy({}, { get: () => () => { throw new Error('mailer used'); } });
  const old = base, s = await appWith(bad);
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const { a, p } = await approveAndPay();
    assert.deepEqual([...(await rows(a.id)), ...(await rows(p.id))].map((r) => [r.kind, r.status]), [['approved', 'pending'], ['paid', 'pending']]);
  } finally { base = old; s.close(); }
});

test('S5 AC-2 hanging mailer with a run in flight: approve and pay under 1 s', async () => {
  const hung = { notifyMail: () => new Promise(() => {}) } as never;
  await mkMoved('submitted', 'approve_final');
  const inflight = runOnce({ prisma, clock: () => new Date(Date.now() + 1000), mailer: hung, publicBaseUrl: 'http://app.test', sendTimeoutMs: 3000, log: createLogger({ write: () => true }) });
  await new Promise((r) => setTimeout(r, 100)); // run is now parked inside the send
  const { ta, tp } = await approveAndPay();
  assert.ok(ta < 1000 && tp < 1000, `${ta} ${tp}`);
  await inflight;
});

test('S5 AC-3 closed SMTP port: actions return 200, one retry line per row', async () => {
  const port = await new Promise<number>((res) => { const l = createServer().listen(0, '127.0.0.1', () => { const p = (l.address() as AddressInfo).port; l.close(() => res(p)); }); });
  const real = createMailer({ smtp: { host: '127.0.0.1', port, user: '', pass: '' } } as never);
  const old = base, s = await appWith(real);
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    await approveAndPay();
    await runOnce({ prisma, clock: () => new Date(Date.now() + 1000), mailer: real, publicBaseUrl: 'http://app.test', log: createLogger({ write: (l: string) => { dlogs.push(l); return true; } }) });
    const ev = dlogs.map((l) => JSON.parse(l).mailEvent);
    assert.deepEqual(ev, ['retry', 'retry']);
  } finally { base = old; s.close(); }
});

test('S5 AC-4 no file under api/src/claims imports mailer or the dispatcher', () => {
  const dir = new URL('../../api/src/claims/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /from\s+['"][^'"]*(mailer|dispatcher)(\.js)?['"]/, f);
});

// CLAIM-8-S6: daily digest.
const D0 = Date.UTC(2026, 0, 5);
const H = 3_600_000;
let nowMs = D0 + 8 * H;
const dsent: { to: string; subject: string; text: string }[] = [];
let dfail = false;
const dmailer = { notifyMail: async (to: string, subject: string, text: string) => { if (dfail) throw new Error('down'); dsent.push({ to, subject, text }); } } as never;
const runD = () => runOnce({ prisma, clock: () => new Date(nowMs), mailer: dmailer, publicBaseUrl: 'http://app.test', log: createLogger({ write: (l: string) => { dlogs.push(l); return true; } }) });
const waiting = (status = 'submitted', approverId = 'mgr') => prisma.claim.create({ data: { claimantId: 'emp', title: `w${++n}`, purpose: 'purpose text', status: status as never, approverId, createdAt: new Date(), updatedAt: new Date(), submittedAt: new Date(D0),
  lines: { create: [{ position: 1, date: '2026-01-01', categoryCode: 'meals', amountCents: 1000, description: 'd', limitCents: 5000 }] } } });
const digests = () => prisma.notification.findMany({ where: { kind: 'digest' } });
beforeEach(() => { nowMs = D0 + 8 * H; dsent.length = 0; dfail = false; });

test('S6 AC-1 three waiting claims give one email on the first tick at 08:00; later ticks and a restart add nothing', async () => {
  await waiting(); await waiting('approved'); await waiting();
  await runD(); nowMs += 30_000; await runD(); await runD();
  assert.equal(dsent.length, 1);
  assert.equal(dsent[0].to, 'mgr@claimflow.test');
  assert.equal(dsent[0].text.split('\n').filter((l) => l.includes('EUR 10.00')).length, 3);
  assert.deepEqual((await digests()).map((r) => r.dedupeKey), ['digest:mgr:2026-01-05']);
});

test('S6 AC-2 nothing queued at 07:59, nor for an approver without waiting claims', async () => {
  await waiting(); nowMs = D0 + 8 * H - 60_000; await runD();
  assert.equal((await digests()).length, 0);
  await prisma.claim.updateMany({ data: { status: 'draft' } }); nowMs = D0 + 9 * H; await runD();
  assert.equal((await digests()).length, 0);
});

test('S6 AC-3 mailer failing then recovering still yields exactly one summary', async () => {
  await waiting(); dfail = true; await runD();
  assert.equal(dsent.length, 0);
  dfail = false; nowMs += 61_000; await runD(); nowMs += 30_000; await runD();
  assert.equal(dsent.length, 1);
  assert.equal((await digests()).length, 1);
});

test('S6 AC-4 the next UTC date gets a new summary while claims still wait', async () => {
  await waiting(); await runD();
  nowMs += 24 * H; await runD();
  assert.equal(dsent.length, 2);
  assert.deepEqual((await digests()).map((r) => r.dedupeKey).sort(), ['digest:mgr:2026-01-05', 'digest:mgr:2026-01-06']);
});

test('S6 AC-5 claim acted on before send leaves the list; empty list is skipped; second stage goes to its own approver', async () => {
  const a = await waiting(); const b = await waiting('approved', 'adm');
  await prisma.user.update({ where: { id: 'adm' }, data: { role: 'manager' } });
  await runD(); // enqueue + send
  assert.deepEqual(dsent.map((m) => m.to).sort(), ['adm@claimflow.test', 'mgr@claimflow.test']);
  assert.equal(dsent.find((m) => m.to === 'mgr@claimflow.test')!.text.includes(b.title), false);
  assert.ok(dsent.find((m) => m.to === 'adm@claimflow.test')!.text.includes(b.title));
  // new day: the only claim is approved by the time of send
  dsent.length = 0; dlogs.length = 0; nowMs += 24 * H;
  await prisma.claim.updateMany({ data: { status: 'rejected' } });
  await prisma.notification.createMany({ data: [{ kind: 'digest', userId: 'mgr', dedupeKey: 'digest:mgr:x', nextAttemptAt: new Date(0) }] });
  await runD();
  const r = await prisma.notification.findUnique({ where: { dedupeKey: 'digest:mgr:x' } });
  assert.equal(r!.status, 'skipped'); assert.equal(dsent.length, 0);
  assert.ok(dlogs.some((l) => JSON.parse(l).mailEvent === 'skipped'));
  assert.ok(a.id);
});

test('S6 AC-6 only claims waiting on that approver are listed', async () => {
  const mine = await waiting(); await waiting('submitted', 'adm');
  await runD();
  const m = dsent.find((x) => x.to === 'mgr@claimflow.test')!;
  assert.ok(m.text.includes(mine.title)); assert.ok(m.text.includes('http://app.test/approvals'));
  assert.equal(m.text.split('\n').filter((l) => l.includes('EUR')).length, 1);
});

test('S6 AC-7 enqueue for 25 approvers issues at most 3 Notification queries', async () => {
  await prisma.user.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, email: `a${i}@claimflow.test`, name: `A${i}`, role: 'manager' as const, passwordHash: 'x' })) });
  for (let i = 0; i < 25; i++) await waiting('submitted', `a${i}`);
  queries.length = 0;
  await prisma.notification.deleteMany();
  queries.length = 0;
  const before = dsent.length;
  await runD();
  const enq = queries.filter((q) => /Notification/.test(q) && /digest|dedupeKey|INSERT/i.test(q) && !/UPDATE|WHERE .*id.*IN/i.test(q));
  assert.ok(enq.length <= 3, `got ${enq.length}`);
  assert.equal(dsent.length - before, 25);
});
