import { test, before, after } from 'node:test';
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
const sess: Record<string, string> = {};
type J = Record<string, any>;

const wipe = async () => {
  await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany();
  await prisma.session.deleteMany(); await prisma.loginAttempt.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
};
async function signIn(id: string) {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: `${id.toLowerCase()}@claimflow.test`, password: PW }) });
  return r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
}
const get = (who: string | null, path = '/api/approvals') => fetch(`${base}${path}`, { headers: who ? { cookie: sess[who] } : {} });
const list = async (who: string, path?: string) => (await (await get(who, path)).json()) as J[];

// E -> M -> S (senior manager); F finance; N nobody's approver.
before(async () => {
  await wipe();
  const passwordHash = await bcrypt.hash(PW, 4);
  const u = (id: string, role: string, extra = {}) => ({ id, email: `${id.toLowerCase()}@claimflow.test`, name: `N-${id}`, role: role as never, passwordHash, ...extra });
  await prisma.user.createMany({ data: [u('S', 'manager'), u('F', 'finance'), u('M', 'manager', { managerId: 'S' }), u('E', 'employee', { managerId: 'M' }), u('N', 'employee')] });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test' } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  for (const id of ['S', 'F', 'M', 'E', 'N']) sess[id] = await signIn(id);
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
