import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { receiptStorage } from '../../api/src/claims/receipt-storage.js';
import { claimRouteDefs, receiptUploadDefs } from '../../api/src/claims/routes.js';
import { ROLES, ROLE_USER, ALL_STATUSES, POS, COVERED, CLAIM_RULES, CLAIM_KEYS, canRead } from './authz-matrix.helpers.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
const store = receiptStorage(mkdtempSync(join(tmpdir(), 'authz-claims-')));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
let srv: Server, base: string;
type S = { cookie: string; csrf: string };
const sessions: Record<string, S> = {};
// The four roles plus `ap`, a manager outside every chain who is the approver of the submitted and approved fixtures.
const ACTORS = [...ROLES.map((r) => [r, ROLE_USER[r]] as const), ['manager', 'ap'] as const];
type Fx = { id: string; claimant: string; pos: string; status: string; approverId: string | null; line: string; receipt: string };
const fx: Fx[] = [];

const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.notification.deleteMany(); await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany();
    await prisma.oneTimeToken.deleteMany(); await prisma.session.deleteMany(); await prisma.loginAttempt.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function signIn(id: string): Promise<S> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id}@claimflow.test`, password: PW }) });
  return { cookie: r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0], csrf: ((await r.json()) as { csrfToken: string }).csrfToken };
}
const call = (s: S, method: string, path: string, body?: unknown, raw?: Buffer) =>
  fetch(`${base}${path}`, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': raw ? 'image/png' : 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });

// One claim per (claimant, status) with one line and one PNG receipt. Lines and receipts go in while draft, then the status is set (paid triggers).
async function mk(n: number, claimant: string, pos: string, status: string) {
  const id = `c${n}`, approverId = status === 'submitted' || status === 'approved' ? 'ap' : null, now = new Date();
  await prisma.claim.create({ data: { id, claimantId: claimant, title: 't', purpose: 'purpose text', status: 'draft', approverId, createdAt: now, updatedAt: now, submittedAt: approverId ? now : null } });
  await prisma.claimLine.create({ data: { id: `${id}-l`, claimId: id, position: 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 100, description: 'x' } });
  await prisma.receipt.create({ data: { id: `${id}-r`, lineId: `${id}-l`, claimId: id, storageKey: await store.put(PNG), sha256: createHash('sha256').update(PNG).digest('hex'), sizeBytes: PNG.length, mime: 'image/png', uploadedById: claimant, uploadedAt: now } });
  if (status !== 'draft') await prisma.claim.update({ where: { id }, data: { status: status as never, ...(status === 'paid' ? { paymentDate: '2026-02-01', paymentReference: 'REF' } : {}) } });
  fx.push({ id, claimant, pos, status, approverId, line: `${id}-l`, receipt: `${id}-r` });
}

before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, extra = {}) => ({ id, email: `${id}@claimflow.test`, name: `N-${id}`, role: role as never, passwordHash, ...extra });
  await prisma.user.createMany({ data: [
    u('adm', 'admin'), u('emp', 'employee'), u('fin', 'finance'), u('U', 'manager'), u('OB', 'manager'), u('ap', 'manager'),
    u('mgr', 'manager', { managerId: 'U' }), u('m1', 'manager', { managerId: 'mgr' }), u('m2', 'manager', { managerId: 'm1' }),
    u('d1', 'employee', { managerId: 'mgr' }), u('d2', 'employee', { managerId: 'm1' }), u('d3', 'employee', { managerId: 'm2' }),
    u('ob', 'employee', { managerId: 'OB' }), u('un', 'employee'),
  ] });
  srv = createApp({ testRoutes: true, log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test', receipts: store } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  for (const [, id] of ACTORS) sessions[id] = await signIn(id);
  let n = 0;
  for (const [pos, claimant] of Object.entries(POS)) for (const st of ALL_STATUSES) await mk(n++, claimant, pos, st);
  for (const claimant of ['emp', 'fin', 'adm']) for (const st of ALL_STATUSES) await mk(n++, claimant, 'unrelated', st);
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

// Position of a claim relative to an actor: only `mgr` has a chain; everyone else is `own` or `unrelated`.
const posFor = (actor: string, c: Fx) => (actor === c.claimant ? 'own' : actor === 'mgr' && (c.pos === 'd1' || c.pos === 'd2') ? c.pos : 'unrelated');

test('AC-1 receipt read matrix: 4 roles x 7 positions x 6 statuses = canRead, 200 returns the bytes', async () => {
  let n = 0;
  for (const role of ROLES) {
    const actor = ROLE_USER[role], s = sessions[actor];
    for (const pos of Object.keys(POS)) for (const status of ALL_STATUSES) {
      const c = fx.find((f) => f.pos === (pos === 'own' && role !== 'manager' ? 'unrelated' : pos) && f.status === status && f.claimant === (pos === 'own' && role !== 'manager' ? actor : POS[pos]))!;
      const r = await call(s, 'GET', `/api/claims/${c.id}/receipts/${c.receipt}`);
      assert.equal(r.status, canRead(role, pos, status), `${role} ${pos} ${status}`);
      if (r.status === 200) assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG, `${role} ${pos} ${status} bytes`);
      else assert.deepEqual(await r.json(), { error: 'forbidden' });
      n++;
    }
  }
  assert.equal(n, 4 * 7 * 6);
});

test('AC-2 lists are scoped to the caller; payments and CSV are finance-only', async () => {
  for (const [role, actor] of ACTORS) {
    const s = sessions[actor];
    const mine = (await (await call(s, 'GET', '/api/claims')).json()) as { id: string }[];
    const own = new Set(fx.filter((f) => f.claimant === actor).map((f) => f.id));
    assert.ok(mine.every((c) => own.has(c.id)), `${actor} /claims`);
    assert.equal(mine.length > 0, own.size > 0, `${actor} /claims non-empty iff it owns claims`);
    const appr = (await (await call(s, 'GET', '/api/approvals')).json()) as { id: string }[];
    const approved = new Set(fx.filter((f) => f.approverId === actor).map((f) => f.id));
    assert.ok(appr.every((c) => approved.has(c.id)), `${actor} /approvals`);
    assert.equal(appr.length, approved.size, `${actor} /approvals`);
    for (const p of ['/api/payments', '/api/exports/paid-claims.csv?from=2026-01-01&to=2026-12-31']) assert.equal((await call(s, 'GET', p)).status, role === 'finance' ? 200 : 403, `${actor} ${p}`);
  }
});

const BODIES: Record<string, { path: (c: Fx) => string; body?: unknown; raw?: Buffer }> = {
  'PATCH /claims/:id': { path: (c) => `/api/claims/${c.id}`, body: { title: 'new title' } },
  'DELETE /claims/:id': { path: (c) => `/api/claims/${c.id}` },
  'POST /claims/:id/lines': { path: (c) => `/api/claims/${c.id}/lines`, body: { date: '2026-03-01', categoryCode: 'meals', amountCents: 100, description: 'y' } },
  'PATCH /claims/:id/lines/:lineId': { path: (c) => `/api/claims/${c.id}/lines/${c.line}`, body: { description: 'z' } },
  'DELETE /claims/:id/lines/:lineId': { path: (c) => `/api/claims/${c.id}/lines/${c.line}` },
  'POST /claims/:id/lines/:lineId/receipts': { path: (c) => `/api/claims/${c.id}/lines/${c.line}/receipts`, raw: PNG },
  'DELETE /claims/:id/receipts/:receiptId': { path: (c) => `/api/claims/${c.id}/receipts/${c.receipt}` },
  'POST /claims/:id/submit': { path: (c) => `/api/claims/${c.id}/submit` },
  'POST /claims/:id/withdraw': { path: (c) => `/api/claims/${c.id}/withdraw`, body: {} },
  'POST /claims/:id/approve': { path: (c) => `/api/claims/${c.id}/approve`, body: {} },
  'POST /claims/:id/reject': { path: (c) => `/api/claims/${c.id}/reject`, body: { reason: 'not a valid expense' } },
  'POST /claims/:id/pay': { path: (c) => `/api/claims/${c.id}/pay`, body: { paymentDate: '2026-01-01', reference: 'REF-1' } },
  'POST /claims/:id/send-back': { path: (c) => `/api/claims/${c.id}/send-back`, body: { reason: 'not a valid expense' } },
};

// 403 or 409, or null when the actor is allowed in this state (the success path is covered elsewhere).
function refusal(key: string, role: string, actor: string, c: Fx): 403 | 409 | null {
  const { actor: rule, okStatuses } = CLAIM_RULES[key];
  const ok = okStatuses.includes(c.status);
  if (rule === 'claimant') return actor !== c.claimant ? 403 : ok ? null : 409;
  if (rule === 'finance') return role !== 'finance' || actor === c.claimant ? 403 : ok ? null : 409;
  // approver (ADR-36/37): self 403, the current approver 409/ok, a reader sees 409 once nothing is pending, anyone else 403
  if (actor === c.claimant) return 403;
  if (c.approverId === actor) return ok ? null : 409;
  return !ok && canRead(role, posFor(actor, c), c.status) === 200 ? 409 : 403;
}

const snap = async () => JSON.stringify([
  await prisma.claim.findMany({ select: { id: true, status: true, updatedAt: true }, orderBy: { id: 'asc' } }),
  await prisma.claimEvent.count(), await prisma.claimLine.count(), await prisma.receipt.count(),
]);

test('AC-3 refusals: 403 / 409 per route, role and position; claim, history, lines and receipts unchanged', async () => {
  let refused = 0;
  for (const [key, req] of Object.entries(BODIES)) {
    const before = await snap();
    for (const [role, actor] of ACTORS) for (const c of fx) {
      const want = refusal(key, role, actor, c);
      if (want === null) continue;
      const r = await call(sessions[actor], key.split(' ')[0], req.path(c), req.body, req.raw);
      assert.equal(r.status, want, `${key} ${actor} ${c.claimant}/${c.status}`);
      refused++;
    }
    assert.equal(await snap(), before, `${key} changed data`);
  }
  assert.ok(refused > 1000);
});

test('AC-4 finance cannot pay its own claim, an approver cannot approve their own', async () => {
  const own = fx.find((f) => f.claimant === 'fin' && f.status === 'ready_to_pay')!;
  const r = await call(sessions.fin, 'POST', `/api/claims/${own.id}/pay`, { paymentDate: '2026-01-01', reference: 'R' });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, 'self_payment');
  const now = new Date();
  await prisma.claim.create({ data: { id: 'self', claimantId: 'ap', title: 't', purpose: 'purpose text', status: 'submitted', approverId: 'ap', createdAt: now, updatedAt: now, submittedAt: now } });
  const a = await call(sessions.ap, 'POST', '/api/claims/self/approve', {});
  assert.equal(a.status, 403);
  assert.equal(((await a.json()) as { error: string }).error, 'self_approval');
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: 'self' } })).status, 'submitted');
});

test('AC-6 every claim and receipt route has a rule and a matrix entry', () => {
  const keys = [...claimRouteDefs({} as never), ...receiptUploadDefs({} as never)].filter((d) => d.data === 'claim').map((d) => `${d.method.toUpperCase()} ${d.path}`).sort();
  assert.equal(keys.length, 20);
  assert.deepEqual(CLAIM_KEYS, keys);
  assert.deepEqual(keys.filter((k) => !COVERED.includes(k)), []);
  assert.deepEqual(Object.keys(BODIES).filter((k) => !(k in CLAIM_RULES)), []);
});
