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
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
// Fixtures need to delete rows the triggers protect: drop all triggers, wipe, restore them verbatim.
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
async function seed() {
  await wipe();
  const hash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, managerId: string | null = null) => ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, active: true, passwordHash: hash });
  await prisma.user.createMany({ data: [u('mgr', 'manager'), u('emp', 'employee', 'mgr'), u('fin', 'finance'), u('adm', 'admin')] });
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: () => {} }), deps: { prisma, clock, mailer: { async linkMail() {}, async reassignedMail() {} } as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
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
const call = (s: S, method: string, path: string, body: unknown = {}) =>
  fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: method === 'DELETE' ? undefined : JSON.stringify(body) });

let n = 0;
// Line and receipt first: the paid triggers refuse them once the claim is paid.
async function mk(status: 'draft' | 'paid') {
  const id = `c${++n}`;
  await prisma.claim.create({ data: { id, claimantId: 'emp', title: 'T', purpose: 'Some purpose text', status: 'draft', createdAt: new Date(0), updatedAt: new Date(0), lines: { create: [{ id: `l${n}`, position: 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 1000, description: 'x' }] } } });
  await prisma.receipt.create({ data: { id: `r${n}`, lineId: `l${n}`, claimId: id, storageKey: `k${n}`, sha256: 'a'.repeat(64), sizeBytes: 3, mime: 'image/png', uploadedById: 'emp', uploadedAt: new Date(0) } });
  if (status === 'paid') await prisma.claim.update({ where: { id }, data: { status: 'paid', paymentDate: '2026-11-24', paymentReference: 'INV-0042' } });
  return { id, lineId: `l${n}`, receiptId: `r${n}` };
}
const sql = (q: string) => prisma.$executeRawUnsafe(q);
const snapshot = async () => JSON.stringify([await prisma.claim.findMany({ orderBy: { id: 'asc' } }), await prisma.claimLine.findMany({ orderBy: { id: 'asc' } }), await prisma.receipt.findMany({ orderBy: { id: 'asc' } })]);

test('AC-3 paid claim: claimant 409 claim_paid, other roles 403, 0 rows change', async () => {
  const c = await mk('paid');
  const before = await snapshot();
  const reqs: [string, string, unknown?][] = [
    ['PATCH', `/claims/${c.id}`, { title: 'New' }], ['PATCH', `/claims/${c.id}/lines/${c.lineId}`, { amountCents: 5 }], ['POST', `/claims/${c.id}/lines`, { date: '2026-03-01', categoryCode: 'meals', amountCents: 1, description: 'y' }],
    ['DELETE', `/claims/${c.id}/lines/${c.lineId}`], ['DELETE', `/claims/${c.id}/receipts/${c.receiptId}`], ['POST', `/claims/${c.id}/lines/${c.lineId}/receipts`],
    ['POST', `/claims/${c.id}/withdraw`, {}], ['POST', `/claims/${c.id}/submit`, {}], ['DELETE', `/claims/${c.id}`],
  ];
  for (const [who, status, err] of [['emp', 409, 'claim_paid'], ['mgr', 403, 'forbidden'], ['fin', 403, 'forbidden'], ['adm', 403, 'forbidden']] as const) {
    const s = await signIn(who);
    for (const [m, p, b] of reqs) {
      const r = await call(s, m, p, b);
      assert.equal(r.status, status, `${who} ${m} ${p}`);
      assert.equal(((await r.json()) as { error: string }).error, err, `${who} ${m} ${p}`);
    }
  }
  assert.equal(await snapshot(), before);
});

test('AC-4 paid claim: raw SQL on Claim, ClaimLine, Receipt aborted by trigger, rows unchanged', async () => {
  const c = await mk('paid');
  const before = await snapshot();
  const stmts = [
    `UPDATE "Claim" SET title = 'x' WHERE id = '${c.id}'`, `DELETE FROM "Claim" WHERE id = '${c.id}'`,
    `INSERT INTO "ClaimLine" (id, claimId, position, date, categoryCode, amountCents, description) VALUES ('nl', '${c.id}', 2, '2026-03-01', 'meals', 1, 'x')`,
    `UPDATE "ClaimLine" SET amountCents = 1 WHERE id = '${c.lineId}'`, `DELETE FROM "ClaimLine" WHERE id = '${c.lineId}'`,
    `INSERT INTO "Receipt" (id, lineId, claimId, storageKey, sha256, sizeBytes, mime, uploadedById, uploadedAt) VALUES ('nr', '${c.lineId}', '${c.id}', 'nk', 'h', 1, 'image/png', 'emp', 0)`,
    `UPDATE "Receipt" SET sizeBytes = 9 WHERE id = '${c.receiptId}'`, `DELETE FROM "Receipt" WHERE id = '${c.receiptId}'`,
  ];
  for (const q of stmts) await assert.rejects(sql(q), q);
  assert.equal(await snapshot(), before);
});

test('AC-4 the same statements succeed on a draft claim', async () => {
  const c = await mk('draft');
  await sql(`UPDATE "Claim" SET title = 'x' WHERE id = '${c.id}'`);
  await sql(`INSERT INTO "ClaimLine" (id, claimId, position, date, categoryCode, amountCents, description) VALUES ('nl', '${c.id}', 2, '2026-03-01', 'meals', 1, 'x')`);
  await sql(`UPDATE "ClaimLine" SET amountCents = 2 WHERE id = '${c.lineId}'`);
  await sql(`INSERT INTO "Receipt" (id, lineId, claimId, storageKey, sha256, sizeBytes, mime, uploadedById, uploadedAt) VALUES ('nr', '${c.lineId}', '${c.id}', 'nk', 'h', 1, 'image/png', 'emp', 0)`);
  await sql(`UPDATE "Receipt" SET sizeBytes = 9 WHERE id = '${c.receiptId}'`);
  await sql(`DELETE FROM "Receipt" WHERE id IN ('${c.receiptId}', 'nr')`);
  await sql(`DELETE FROM "ClaimLine" WHERE claimId = '${c.id}'`);
  await sql(`DELETE FROM "Claim" WHERE id = '${c.id}'`);
  assert.equal(await prisma.claim.count(), 0);
});

test('AC-2 raw UPDATE/DELETE on ClaimEvent and deleting a user or claim with events all fail', async () => {
  const c = await mk('draft');
  await prisma.claimEvent.create({ data: { claimId: c.id, seq: 1, actorId: 'emp', action: 'submit', fromStatus: 'draft', toStatus: 'submitted', at: new Date(0) } });
  const before = JSON.stringify(await prisma.claimEvent.findMany());
  await assert.rejects(sql(`UPDATE "ClaimEvent" SET reason = 'x'`));
  await assert.rejects(sql(`DELETE FROM "ClaimEvent"`));
  await assert.rejects(sql(`PRAGMA foreign_keys = ON`).then(() => sql(`DELETE FROM "User" WHERE id = 'emp'`)));
  await assert.rejects(sql(`DELETE FROM "Claim" WHERE id = '${c.id}'`));
  await assert.rejects(prisma.user.delete({ where: { id: 'emp' } }));
  assert.equal(JSON.stringify(await prisma.claimEvent.findMany()), before);
  assert.equal(await prisma.user.count({ where: { id: 'emp' } }), 1);
  assert.equal(await prisma.claim.count({ where: { id: c.id } }), 1);
});

test('CLAIM-4 S1 submit_policy migration is additive and T1..T10 survive', async () => {
  const dir = (await import('node:fs')).readdirSync('prisma/migrations').find((n) => n.endsWith('_submit_policy'))!;
  const m = (await import('node:fs')).readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');
  assert.equal((m.match(/ALTER TABLE "ClaimLine" ADD COLUMN/g) ?? []).length, 3);
  assert.equal((m.match(/CREATE INDEX "ClaimLine_date_categoryCode_amountCents_idx"/g) ?? []).length, 1);
  assert.doesNotMatch(m, /DROP TABLE|PRAGMA foreign_keys|new_ClaimLine/);
  const names = ((await prisma.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)) as { name: string }[]).map((r) => r.name);
  for (const n of ['claim_event_no_update', 'claim_event_no_delete', 'claim_paid_no_update', 'claim_paid_no_delete', 'line_paid_ins', 'line_paid_upd', 'line_paid_del', 'receipt_paid_ins', 'receipt_paid_upd', 'receipt_paid_del', 'claim_paid_needs_payment']) assert.ok(names.includes(n), n);
});

test('CLAIM-6 S1 AC-1/AC-2 paid needs date and reference; payment record then frozen', async () => {
  const c = await mk('draft');
  await prisma.claim.update({ where: { id: c.id }, data: { status: 'ready_to_pay' } });
  await assert.rejects(sql(`UPDATE "Claim" SET status = 'paid' WHERE id = '${c.id}'`), /claim_paid_needs_payment/);
  await assert.rejects(sql(`UPDATE "Claim" SET status = 'paid', paymentDate = '2026-11-24' WHERE id = '${c.id}'`), /claim_paid_needs_payment/);
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { id: c.id } })).status, 'ready_to_pay');
  await sql(`UPDATE "Claim" SET status = 'paid', paymentDate = '2026-11-24', paymentReference = 'INV-0042' WHERE id = '${c.id}'`);
  await assert.rejects(sql(`UPDATE "Claim" SET paymentReference = 'X' WHERE id = '${c.id}'`), /claim_paid_no_update/);
});
