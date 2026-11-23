import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { approveClaim, rejectClaim } from '../../api/src/claims/service.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
const sess: Record<string, string> = {};
const csrf: Record<string, string> = {};
const logs: string[] = [];
type J = Record<string, any>;

// History rows and paid claims are immutable by trigger; cleanup drops the delete guards and restores them verbatim.
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany();
    await prisma.session.deleteMany(); await prisma.loginAttempt.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id.toLowerCase()}@claimflow.test`, password: PW }) });
  csrf[id] = ((await r.json()) as { csrfToken: string }).csrfToken;
  return r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
}
const get = (who: string | null, path = '/api/approvals') => fetch(`${base}${path}`, { headers: who ? { cookie: sess[who] } : {} });
const list = async (who: string, path?: string) => (await (await get(who, path)).json()) as J[];

// E -> M -> S (senior manager); F finance; N nobody's approver.
before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, extra = {}) => ({ id, email: `${id.toLowerCase()}@claimflow.test`, name: `N-${id}`, role: role as never, passwordHash, ...extra });
  await prisma.user.createMany({ data: [u('A', 'admin'), u('S', 'manager'), u('F', 'finance'), u('M', 'manager', { managerId: 'S' }), u('E', 'employee', { managerId: 'M' }), u('N', 'employee'), u('M2', 'manager', { managerId: 'S' }), u('I', 'manager', { managerId: 'S', active: false }), u('M3', 'manager', { managerId: 'I' }), u('E3', 'employee', { managerId: 'M3' })] });
  srv = createApp({ log: createLogger({ write: (l: string) => { logs.push(l); return true; } }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  for (const id of ['S', 'F', 'M', 'E', 'N', 'M2', 'M3', 'A']) sess[id] = await signIn(id);
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

let n = 0;
const mk = async (status: string, approverId: string | null, lines: { amountCents: number; limitCents?: number; dup?: string }[] = [{ amountCents: 100 }], at = new Date(Date.UTC(2026, 0, 1, 0, 0, ++n))) => {
  const c = await prisma.claim.create({ data: {
    claimantId: 'E', title: `t${n}`, purpose: 'purpose text', status: status as never, approverId, createdAt: at, updatedAt: at, submittedAt: approverId ? at : null,
    lines: { create: lines.map((l, i) => ({ position: i + 1, date: '2026-01-01', categoryCode: 'meals', amountCents: l.amountCents, description: `d${i + 1}`, limitCents: l.limitCents ?? 5000, ...(l.dup ? { duplicateClaimId: l.dup, duplicateBasis: 'receipt' } : {}) })) },
  }, include: { lines: true } });
  return c;
};

test('AC-1/AC-5(flags) claim appears only for the manager, with total, flags and receipts', async () => {
  const other = await mk('draft', null);
  const c = await mk('submitted', 'M', [{ amountCents: 9000 }, { amountCents: 100, dup: other.id }]);
  await prisma.receipt.create({ data: { lineId: c.lines[0].id, claimId: c.id, storageKey: `k-${c.id}`, sha256: 'x', sizeBytes: 3, mime: 'image/png', originalName: 'r.png', uploadedById: 'E', uploadedAt: new Date() } });
  const m = await list('M');
  const row = m.find((r) => r.id === c.id)!;
  assert.ok(row);
  assert.equal(row.stage, 'first'); assert.equal(row.status, 'submitted');
  assert.equal(row.totalCents, 9100); assert.equal(row.overLimitCount, 1); assert.equal(row.duplicateCount, 1);
  assert.deepEqual(row.claimant, { id: 'E', name: 'N-E' });
  assert.equal(row.lines[0].overLimit, true); assert.equal(row.lines[0].duplicate, null);
  assert.deepEqual(row.lines[0].receipts, [{ id: row.lines[0].receipts[0].id, mime: 'image/png', originalName: 'r.png' }]);
  assert.deepEqual(row.lines[1].duplicate, { claimId: other.id, basis: 'receipt' }); assert.equal(row.lines[1].overLimit, false);
  for (const who of ['S', 'F', 'E']) assert.equal((await list(who)).some((r) => r.id === c.id), false, who);
});

test('AC-2 only pending states are listed', async () => {
  const ids = [(await mk('draft', 'M')).id, (await mk('rejected', 'M')).id, (await mk('ready_to_pay', 'M')).id, (await mk('draft', null)).id]; // withdrawn claims return to draft; paid rows are undeletable by trigger (covered by the status filter)
  const got = (await list('M')).map((r) => r.id);
  for (const id of ids) assert.equal(got.includes(id), false);
});

test('AC-3 approved claim shows in the second approver list as stage second', async () => {
  const c = await mk('approved', 'S');
  const row = (await list('S')).find((r) => r.id === c.id)!;
  assert.equal(row.stage, 'second');
  assert.equal((await list('M')).some((r) => r.id === c.id), false);
});

test('AC-4 nobody-approver gets 200 [] for any role; unauthenticated 401', async () => {
  for (const who of ['N', 'E', 'F']) { const r = await get(who); assert.equal(r.status, 200); assert.deepEqual(await r.json(), []); }
  assert.equal((await get(null)).status, 401);
});

test('AC-5 order by submittedAt then id; paging; invalid limit/offset 422', async () => {
  const a = await mk('submitted', 'S', undefined, new Date(Date.UTC(2020, 0, 1)));
  const b = await mk('submitted', 'S', undefined, new Date(Date.UTC(2020, 0, 1)));
  const old = await mk('submitted', 'S', undefined, new Date(Date.UTC(2019, 0, 1)));
  const ids = (await list('S')).map((r) => r.id);
  const [x, y] = [a.id, b.id].sort();
  assert.deepEqual(ids.slice(0, 3), [old.id, x, y]);
  assert.deepEqual((await list('S', '/api/approvals?limit=1&offset=1')).map((r) => r.id), [x]);
  for (const q of ['limit=0', 'limit=101', 'limit=x', 'offset=-1']) {
    const r = await get('S', `/api/approvals?${q}`);
    assert.equal(r.status, 422, q);
    assert.equal(((await r.json()) as J).error, 'invalid_input');
  }
});

// ---- approve (E-34): one test per story/epic AC ----
const post = (who: string, id: string, body: unknown = {}, token: string | null = csrf[who]) => fetch(`${base}/api/claims/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess[who], ...(token ? { 'x-csrf-token': token } : {}) }, body: JSON.stringify(body) });
const mkc = async (claimantId: string, status: string, approverId: string | null, cents: number[]) => {
  const now = new Date();
  return prisma.claim.create({ data: { claimantId, title: 't', purpose: 'purpose text', status: status as never, approverId, createdAt: now, updatedAt: now, submittedAt: approverId ? now : null,
    lines: { create: cents.map((c, i) => ({ position: i + 1, date: '2026-01-01', categoryCode: 'meals', amountCents: c, description: 'd', limitCents: 5000 })) } }, include: { lines: true } });
};
const state = async (id: string) => {
  const c = await prisma.claim.findUniqueOrThrow({ where: { id }, include: { events: { orderBy: { seq: 'asc' } }, lines: true } });
  return { status: c.status, approverId: c.approverId, actions: c.events.map((e) => e.action), amounts: c.lines.map((l) => l.amountCents), updatedAt: c.updatedAt.getTime() };
};
const code = async (r: Response) => ((await r.json()) as J).error;

test('approve AC-1 total 200,000 goes straight to ready_to_pay with approve_final', async () => {
  const c = await mkc('E', 'submitted', 'M', [150_000, 50_000]);
  const r = await post('M', c.id);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as J).status, 'ready_to_pay');
  const s = await state(c.id);
  assert.deepEqual([s.status, s.actions], ['ready_to_pay', ['approve_final']]);
});

test('approve AC-2 over 200,000 waits for the second approver, who then finishes it', async () => {
  const c = await mkc('E', 'submitted', 'M', [200_001]);
  assert.equal((await post('M', c.id)).status, 200);
  assert.deepEqual(await state(c.id), { ...(await state(c.id)), status: 'approved', approverId: 'S', actions: ['approve_first'] });
  assert.equal((await list('S')).find((r) => r.id === c.id)!.stage, 'second');
  assert.equal(await code(await post('M', c.id)), 'invalid_transition'); // M gave the first approval: lost its turn, 409 not 403 (ADR-37)
  assert.equal((await post('S', c.id)).status, 200);
  assert.deepEqual((await state(c.id)).actions, ['approve_first', 'approve_second']);
  assert.equal((await state(c.id)).status, 'ready_to_pay');
});

test('approve AC-3 no manager above, or inactive manager above, still resolves', async () => {
  const top = await mkc('M', 'submitted', 'S', [300_000]); // manager's own claim, approver S has no manager
  assert.equal((await post('S', top.id)).status, 200);
  assert.deepEqual((await state(top.id)).actions, ['approve_final']);
  const skip = await mkc('E3', 'submitted', 'M3', [300_000]); // M3's manager I is inactive; S is above I
  assert.equal((await post('M3', skip.id)).status, 200);
  const s = await state(skip.id);
  assert.deepEqual([s.status, s.approverId], ['approved', 'S']);
});

test('approve AC-4 self-approval, manager routing and authority', async () => {
  const own = await mkc('M', 'submitted', 'S', [100]); // submit rule routes a manager's claim to their manager
  assert.equal((await list('S')).some((r) => r.id === own.id), true);
  assert.equal((await list('M')).some((r) => r.id === own.id), false);
  const forced = await mkc('M', 'submitted', 'M', [100]);
  const before = await state(forced.id);
  const r = await post('M', forced.id);
  assert.deepEqual([r.status, await code(r)], [403, 'self_approval']);
  assert.deepEqual(await state(forced.id), before);
  const c = await mkc('E', 'submitted', 'M', [100]);
  for (const who of ['M2', 'S', 'F', 'A']) { const x = await post(who, c.id); assert.deepEqual([who, x.status, await code(x)], [who, 403, 'forbidden']); }
  const missing = await post('F', 'nope');
  assert.deepEqual([missing.status, await code(missing)], [404, 'not_found']);
  assert.equal((await state(c.id)).status, 'submitted');
});

test('approve AC-5 separation of duties and state errors', async () => {
  const c = await mkc('E', 'approved', 'M', [300_000]);
  await prisma.claimEvent.create({ data: { claimId: c.id, actorId: 'M', action: 'approve_first', fromStatus: 'submitted', toStatus: 'approved', seq: 1, at: new Date() } });
  const before = await state(c.id);
  const r = await post('M', c.id);
  assert.deepEqual([r.status, await code(r)], [403, 'forbidden']);
  assert.deepEqual(await state(c.id), before);
  for (const st of ['draft', 'rejected', 'ready_to_pay']) {
    const x = await mkc('E', st, 'M', [100]);
    const res = await post('M', x.id);
    assert.deepEqual([st, res.status, await code(res)], [st, 409, 'invalid_transition']);
  }
  const paid = await mkc('E', 'ready_to_pay', 'M', [100]); // a paid claim refuses line inserts, so move it after
  await prisma.claim.update({ where: { id: paid.id }, data: { status: 'paid' } });
  const res = await post('M', paid.id);
  assert.deepEqual([res.status, await code(res)], [409, 'claim_paid']);
});

test('approve AC-6 two approves, or approve racing withdraw, give one 200 and one 409', async () => {
  const a = await mkc('E', 'submitted', 'M', [100]);
  const rs = await Promise.all([post('M', a.id), post('M', a.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual((await state(a.id)).actions, ['approve_final']);
  const w = await mkc('E', 'submitted', 'M', [100]);
  const wd = () => fetch(`${base}/api/claims/${w.id}/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess.E, 'x-csrf-token': csrf.E }, body: '{}' });
  const both = await Promise.all([post('M', w.id), wd()]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await state(w.id)).actions.length, 1);
  const loser = both.find((r) => r.status === 409)!;
  assert.equal(await code(loser), 'invalid_transition');
});

test('approve AC-7 body amounts ignored, failure rolls back, log line is clean', async () => {
  const c = await mkc('E', 'submitted', 'M', [300_000]);
  const before = await state(c.id);
  const d = { prisma, clock: () => new Date(), receipts: {} as never, beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(approveClaim(d, { id: 'M', role: 'manager' }, c.id), /boom/);
  assert.deepEqual(await state(c.id), before); // status, approverId, history together
  logs.length = 0;
  const r = await post('M', c.id, { amountCents: 1, lines: [], status: 'paid', reason: 'secret reason text' });
  assert.equal(r.status, 200);
  const s = await state(c.id);
  assert.deepEqual([s.status, s.approverId, s.amounts], ['approved', 'S', [300_000]]);
  const line = logs.map((l) => JSON.parse(l) as J).find((l) => l.claimEvent === 'approve_first')!;
  assert.equal(line.claimId, c.id); assert.equal(line.from, 'submitted'); assert.equal(line.to, 'approved');
  assert.equal(logs.join('').includes('secret reason'), false);
});

test('approve AC-8 route is claim data, CSRF is required, and 20 approvals over 10,000 claims stay under 500 ms p95', async () => {
  const missing = await post('M', 'x', {}, null);
  assert.deepEqual([missing.status, await code(missing)], [403, 'csrf']);
  const now = new Date();
  await prisma.claim.createMany({ data: Array.from({ length: 10_000 }, (_, i) => ({ id: `bulk${i}`, claimantId: 'E', title: 't', purpose: 'purpose text', status: 'draft' as never, createdAt: now, updatedAt: now })) });
  const ids = (await Promise.all(Array.from({ length: 20 }, () => mkc('E', 'submitted', 'M', [100])))).map((c) => c.id);
  const times: number[] = [];
  for (const id of ids) { const t = performance.now(); assert.equal((await post('M', id)).status, 200); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  assert.ok(times[18] < 500, `p95 ${times[18]}`);
});

// ---- reject (E-35): one test per story/epic AC ----
const rej = (who: string, id: string, body: unknown = { reason: 'not a business expense' }, token: string | null = csrf[who]) => fetch(`${base}/api/claims/${id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess[who], ...(token ? { 'x-csrf-token': token } : {}) }, body: JSON.stringify(body) });
const reasons = async (id: string) => (await prisma.claimEvent.findMany({ where: { claimId: id }, orderBy: { seq: 'asc' } })).map((e) => [e.action, e.reason]);

test('reject AC-1 reason required: missing/empty/blank/9 chars 422, 10 chars 200 with reason in history', async () => {
  const c = await mkc('E', 'submitted', 'M', [100]);
  for (const body of [{}, { reason: '' }, { reason: '          ' }, { reason: '123456789' }, { reason: '  123456789  ' }, { reason: 5 }]) {
    const r = await rej('M', c.id, body);
    assert.deepEqual([r.status, await code(r)], [422, 'reason_required'], JSON.stringify(body));
  }
  assert.deepEqual(await state(c.id), { ...(await state(c.id)), status: 'submitted', actions: [] });
  const ok = await rej('M', c.id, { reason: '  1234567890  ' });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as J).status, 'rejected');
  assert.deepEqual(await reasons(c.id), [['reject', '1234567890']]);
});

test('reject AC-2 501 characters is invalid_input, 500 is fine', async () => {
  const c = await mkc('E', 'submitted', 'M', [100]);
  const r = await rej('M', c.id, { reason: 'x'.repeat(501) });
  assert.deepEqual([r.status, await code(r)], [422, 'invalid_input']);
  assert.equal((await state(c.id)).status, 'submitted');
  assert.equal((await rej('M', c.id, { reason: 'x'.repeat(500) })).status, 200);
});

test('reject AC-3 second approver rejects an approved claim; employee sees it rejected and editable', async () => {
  const c = await mkc('E', 'submitted', 'M', [300_000]);
  assert.equal((await post('M', c.id)).status, 200);
  assert.equal((await rej('S', c.id)).status, 200);
  assert.deepEqual((await state(c.id)).actions, ['approve_first', 'reject_second']);
  const mine = (await (await fetch(`${base}/api/claims`, { headers: { cookie: sess.E } })).json()) as J;
  assert.equal((mine.items ?? mine).find((x: J) => x.id === c.id).status, 'rejected');
  const edit = await fetch(`${base}/api/claims/${c.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: sess.E, 'x-csrf-token': csrf.E }, body: JSON.stringify({ title: 'fixed' }) });
  assert.equal(edit.status, 200);
});

test('reject AC-4 authority and state errors, 404 first, 409 before 422', async () => {
  const forced = await mkc('M', 'submitted', 'M', [100]);
  const own = await rej('M', forced.id);
  assert.deepEqual([own.status, await code(own)], [403, 'self_approval']);
  const c = await mkc('E', 'submitted', 'M', [100]);
  for (const who of ['M2', 'S', 'F', 'A']) { const x = await rej(who, c.id); assert.deepEqual([who, x.status, await code(x)], [who, 403, 'forbidden']); }
  const missing = await rej('F', 'nope');
  assert.deepEqual([missing.status, await code(missing)], [404, 'not_found']);
  assert.deepEqual((await state(c.id)).actions, []);
  assert.deepEqual((await state(forced.id)).actions, []);
  for (const st of ['draft', 'rejected', 'ready_to_pay']) {
    const x = await mkc('E', st, 'M', [100]);
    const res = await rej('M', x.id, { reason: 'x' });
    assert.deepEqual([st, res.status, await code(res)], [st, 409, 'invalid_transition']);
  }
});

test('reject AC-5 body amounts/lines/status ignored; only status changes', async () => {
  const c = await mkc('E', 'submitted', 'M', [300_000]);
  const r = await rej('M', c.id, { reason: 'not a business expense', amountCents: 1, lines: [], status: 'paid' });
  assert.equal(r.status, 200);
  const s = await state(c.id);
  assert.deepEqual([s.status, s.amounts], ['rejected', [300_000]]);
});

test('reject AC-6 racing actions give one 200 and one 409; rollback; log line has no reason; CSRF; under 500 ms p95', async () => {
  const a = await mkc('E', 'submitted', 'M', [100]);
  const rs = await Promise.all([rej('M', a.id), post('M', a.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await state(a.id)).actions.length, 1);
  const b = await mkc('E', 'submitted', 'M', [100]);
  assert.deepEqual((await Promise.all([rej('M', b.id), rej('M', b.id)])).map((r) => r.status).sort(), [200, 409]);
  assert.equal((await state(b.id)).actions.length, 1);
  const c = await mkc('E', 'submitted', 'M', [100]);
  const before = await state(c.id);
  const d = { prisma, clock: () => new Date(), receipts: {} as never, beforeAppend: () => { throw new Error('boom'); } };
  await assert.rejects(rejectClaim(d, { id: 'M', role: 'manager' }, c.id, { reason: 'not a business expense' }), /boom/);
  assert.deepEqual(await state(c.id), before);
  logs.length = 0;
  assert.equal((await rej('M', c.id, { reason: 'secret reason text' })).status, 200);
  const line = logs.map((l) => JSON.parse(l) as J).find((l) => l.claimEvent === 'reject')!;
  assert.deepEqual([line.claimId, line.from, line.to], [c.id, 'submitted', 'rejected']);
  assert.equal(logs.join('').includes('secret reason'), false);
  const missing = await rej('M', 'x', {}, null);
  assert.deepEqual([missing.status, await code(missing)], [403, 'csrf']);
  const ids = (await Promise.all(Array.from({ length: 20 }, () => mkc('E', 'submitted', 'M', [100])))).map((x) => x.id);
  const times: number[] = [];
  for (const id of ids) { const t = performance.now(); assert.equal((await rej('M', id)).status, 200); times.push(performance.now() - t); }
  times.sort((x, y) => x - y);
  assert.ok(times[18] < 500, `p95 ${times[18]}`);
});

test('reject AC-5b the approver cannot write claim or line routes: 403, no row changes', async () => {
  const c = await mkc('E', 'submitted', 'M', [100]);
  const before = await state(c.id);
  const lid = c.lines[0].id;
  const w = (method: string, path: string) => fetch(`${base}/api/claims/${c.id}${path}`, { method, headers: { 'content-type': 'application/json', cookie: sess.M, 'x-csrf-token': csrf.M }, body: method === 'DELETE' ? undefined : JSON.stringify({ amountCents: 1, title: 'x', date: '2026-01-01', categoryCode: 'meals', description: 'd' }) });
  for (const [m, p] of [['PATCH', `/lines/${lid}`], ['POST', '/lines'], ['DELETE', `/lines/${lid}`], ['PATCH', '']]) assert.equal((await w(m, p)).status, 403, `${m} ${p}`);
  assert.deepEqual(await state(c.id), before);
});
