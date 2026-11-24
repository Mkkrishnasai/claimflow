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

// History rows and paid claims are immutable by trigger (T1..T10); cleanup drops the delete guards and restores them verbatim.
const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try { await clean(); } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
const clean = async () => {
  await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
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

// ---- CLAIM-3-S3: edit and delete ----
const call = (s: S | null, method: string, path: string, body?: unknown, csrf: string | null = s?.csrf ?? null) =>
  fetch(`${base}/api${path}`, { method, headers: { ...(s ? { cookie: s.cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const mk = async (status: string, claimantId = 'emp', n = 1) => {
  const now = new Date();
  const c = (await prisma.claim.create({ data: { claimantId, title: 't', purpose: 'purpose text', status: 'draft', createdAt: now, updatedAt: now, lines: { create: Array.from({ length: n }, (_, i) => ({ position: i + 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 1000, description: 'd' })) } }, include: { lines: true } }));
  if (status !== 'draft') await prisma.claim.update({ where: { id: c.id }, data: { status: status as never, ...(status === 'paid' ? { paymentDate: '2026-11-24', paymentReference: 'INV-0042' } : {}) } }); // lines first: a paid claim refuses inserts
  return c;
};

test('S3 AC-1 edit title, add/patch/delete line on draft and rejected; status and history untouched', async () => {
  const s = await signIn('emp');
  for (const status of ['draft', 'rejected']) {
    const c = await mk(status);
    if (status === 'rejected') await prisma.claimEvent.create({ data: { claimId: c.id, seq: 1, actorId: 'mgr', action: 'reject' as never, fromStatus: 'submitted', toStatus: 'rejected', reason: 'no', at: new Date() } });
    let r = await call(s, 'PATCH', `/claims/${c.id}`, { title: 'New', status: 'paid', claimantId: 'mgr', approverId: 'mgr', limitCents: 1 });
    assert.equal(r.status, 200);
    let j = (await r.json()) as J;
    assert.equal(j.title, 'New'); assert.equal(j.status, status); assert.equal(j.claimantId, 'emp'); assert.equal(j.approverId, null);
    r = await call(s, 'POST', `/claims/${c.id}/lines`, line({ amountCents: 300, limitCents: 1 }));
    assert.equal(r.status, 201);
    j = (await r.json()) as J;
    assert.equal(j.totalCents, 1300); assert.equal(j.lines[1].limitCents, null);
    r = await call(s, 'PATCH', `/claims/${c.id}/lines/${c.lines[0].id}`, { amountCents: 5001 });
    j = (await r.json()) as J;
    assert.equal(r.status, 200); assert.equal(j.totalCents, 5301); assert.equal(j.lines[0].overLimit, true); assert.equal(j.lines[0].description, 'd');
    assert.equal((await call(s, 'DELETE', `/claims/${c.id}/lines/${c.lines[0].id}`)).status, 204);
    assert.equal((await prisma.claim.findUnique({ where: { id: c.id } }))!.status, status);
    assert.equal(await prisma.claimEvent.count({ where: { claimId: c.id } }), status === 'rejected' ? 1 : 0);
  }
});

test('S3 AC-2 submitted/approved/ready_to_pay 409 claim_not_editable, paid 409 claim_paid, 0 rows changed', async () => {
  const s = await signIn('emp');
  for (const [status, code] of [['submitted', 'claim_not_editable'], ['approved', 'claim_not_editable'], ['ready_to_pay', 'claim_not_editable'], ['paid', 'claim_paid']]) {
    const c = await mk(status), l = c.lines[0].id;
    for (const [m, p, b] of [['PATCH', `/claims/${c.id}`, { title: 'X' }], ['POST', `/claims/${c.id}/lines`, line()], ['PATCH', `/claims/${c.id}/lines/${l}`, { amountCents: 1 }], ['DELETE', `/claims/${c.id}/lines/${l}`, undefined], ['DELETE', `/claims/${c.id}`, undefined]] as [string, string, unknown][]) {
      const r = await call(s, m, p, b);
      assert.equal(r.status, 409, `${status} ${m} ${p}`); assert.equal(((await r.json()) as J).error, code);
    }
    const after = await prisma.claim.findUnique({ where: { id: c.id }, include: { lines: true } });
    assert.equal(after!.title, 't'); assert.equal(after!.lines.length, 1); assert.equal(after!.lines[0].amountCents, 1000);
  }
});

test('S3 AC-3 non-claimants 403 even with invalid body, 401 anonymous, 403 csrf, 404 before 403', async () => {
  const c = await mk('draft'), l = c.lines[0].id;
  const routes: [string, string][] = [['PATCH', `/claims/${c.id}`], ['DELETE', `/claims/${c.id}`], ['POST', `/claims/${c.id}/lines`], ['PATCH', `/claims/${c.id}/lines/${l}`], ['DELETE', `/claims/${c.id}/lines/${l}`]];
  const adm = await prisma.user.create({ data: { id: 'adm', email: 'adm@claimflow.test', name: 'adm', role: 'admin', active: true, passwordHash: (await prisma.user.findUnique({ where: { id: 'emp' } }))!.passwordHash } });
  for (const who of ['mgr', 'fin', adm.id]) {
    const s = await signIn(who);
    for (const [m, p] of routes) { const r = await call(s, m, p, { amountCents: 'bad', title: '' }); assert.equal(r.status, 403, `${who} ${m} ${p}`); assert.deepEqual(await r.json(), { error: 'forbidden' }); }
    assert.equal((await call(s, 'PATCH', '/claims/nope', {})).status, 404);
  }
  const e = await signIn('emp');
  for (const [m, p] of routes) {
    assert.equal((await call(null, m, p, {})).status, 401);
    const r = await call(e, m, p, {}, null); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'csrf' });
  }
  assert.equal((await prisma.claim.findUnique({ where: { id: c.id } }))!.title, 't');
});

test('S3 AC-4 delete: draft without history 204, with history 409 has_history, repeat 404', async () => {
  const s = await signIn('emp');
  const a = await mk('draft'), b = await mk('draft');
  await prisma.claimEvent.create({ data: { claimId: b.id, seq: 1, actorId: 'emp', action: 'withdrawn' as never, fromStatus: 'submitted', toStatus: 'draft', at: new Date() } });
  assert.equal((await call(s, 'DELETE', `/claims/${a.id}`)).status, 204);
  assert.equal(await prisma.claim.count({ where: { id: a.id } }), 0); assert.equal(await prisma.claimLine.count({ where: { claimId: a.id } }), 0);
  assert.equal((await call(s, 'DELETE', `/claims/${a.id}`)).status, 404);
  const r = await call(s, 'DELETE', `/claims/${b.id}`);
  assert.equal(r.status, 409); assert.equal(((await r.json()) as J).error, 'has_history');
  assert.equal(await prisma.claim.count({ where: { id: b.id } }), 1);
});

test('S3 AC-5 51st line refused; patch is atomic and validated', async () => {
  const s = await signIn('emp');
  const c = await mk('draft', 'emp', 50);
  const r = await call(s, 'POST', `/claims/${c.id}/lines`, line());
  assert.equal(r.status, 422); assert.equal(((await r.json()) as J).reason, 'A claim can have at most 50 lines');
  assert.equal(await prisma.claimLine.count({ where: { claimId: c.id } }), 50);
  const l = c.lines[0];
  const bad = await call(s, 'PATCH', `/claims/${c.id}/lines/${l.id}`, { description: 'changed', amountCents: 12.5 });
  assert.equal(bad.status, 422);
  assert.equal((await prisma.claimLine.findUnique({ where: { id: l.id } }))!.description, 'd');
  assert.equal((await call(s, 'PATCH', `/claims/${c.id}/lines/nope`, { amountCents: 5 })).status, 404);
  assert.equal((await call(s, 'PATCH', `/claims/${c.id}`, { purpose: 'short' })).status, 422);
});

test('CLAIM-4 S1 justification: stored on add, null clears, omitted keeps, 501/number refused, blank -> null, server fields ignored', async () => {
  const s = await signIn('emp');
  const c = await mk('draft');
  const id = c.lines[0].id, base = `/claims/${c.id}/lines`;
  let r = await call(s, 'POST', base, line({ justification: 'Client dinner, 6 guests' }));
  assert.equal(r.status, 201);
  const added = ((await r.json()) as J).lines[1];
  assert.equal(added.justification, 'Client dinner, 6 guests'); assert.equal(added.overLimit, false);
  r = await call(s, 'PATCH', `${base}/${added.id}`, { description: 'x' });
  assert.equal(((await r.json()) as J).lines[1].justification, 'Client dinner, 6 guests');
  r = await call(s, 'PATCH', `${base}/${added.id}`, { justification: null });
  assert.equal(((await r.json()) as J).lines[1].justification, null);
  const before = await prisma.claimLine.findMany({ orderBy: { id: 'asc' } });
  for (const justification of ['x'.repeat(501), 7]) {
    for (const [m, p, b] of [['POST', base, line({ justification })], ['PATCH', `${base}/${id}`, { justification }]] as [string, string, unknown][]) {
      r = await call(s, m, p, b);
      assert.equal(r.status, 422); const j = (await r.json()) as J;
      assert.equal(j.error, 'invalid_input'); assert.equal(j.reason, 'justification must be at most 500 characters');
    }
  }
  assert.deepEqual(await prisma.claimLine.findMany({ orderBy: { id: 'asc' } }), before);
  r = await call(s, 'PATCH', `${base}/${id}`, { justification: 'y'.repeat(500) });
  assert.equal(r.status, 200);
  r = await call(s, 'PATCH', `${base}/${id}`, { justification: '   ', duplicateClaimId: 'x', duplicateBasis: 'match', overLimit: true, status: 'paid' });
  assert.equal(r.status, 200);
  const row = (await prisma.claimLine.findUnique({ where: { id } }))!;
  assert.equal(row.justification, null); assert.equal(row.duplicateClaimId, null); assert.equal(row.duplicateBasis, null);
  assert.equal((await prisma.claim.findUnique({ where: { id: c.id } }))!.status, 'draft');
  r = await call(s, 'PATCH', `${base}/${id}`, { amountCents: 5000, justification: 'a'.repeat(25) });
  const l = ((await r.json()) as J).lines[0];
  assert.equal(l.justification, 'a'.repeat(25)); assert.equal(l.overLimit, false);
});
