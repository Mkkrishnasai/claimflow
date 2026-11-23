import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { receiptStorage, type ReceiptStore } from '../../api/src/claims/receipt-storage.js';

const PW = 'correct horse battery';
const prisma = new PrismaClient();
const dir = mkdtempSync(join(tmpdir(), 'rcpt-'));
const real = receiptStorage(dir);
let store: ReceiptStore = real;
const proxy: ReceiptStore = { ensureDir: () => real.ensureDir(), put: (b) => store.put(b), remove: (k) => store.remove(k) };
let srv: Server, base: string;
const out: string[] = [];
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const PDF = (n = 20) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 9), 0x61)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

const GUARDS = ['claim_event_no_delete', 'claim_paid_no_delete', 'line_paid_del', 'receipt_paid_del'];
const wipe = async () => {
  const g = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map((n) => `'${n}'`).join(',')})`);
  for (const t of g) await prisma.$executeRawUnsafe(`DROP TRIGGER "${t.name}"`);
  try {
    await prisma.claimEvent.deleteMany(); await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
  } finally { for (const t of g) await prisma.$executeRawUnsafe(t.sql); }
};
const mkClaim = async (id: string, claimantId: string, status = 'draft') => {
  await prisma.claim.create({ data: { id, claimantId, title: 't', purpose: 'purpose text', status: status as never, createdAt: new Date(), updatedAt: new Date() } });
  await prisma.claimLine.create({ data: { id: `${id}-l`, claimId: id, position: 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 100, description: 'x' } });
};
async function seed() {
  await wipe();
  store = real;
  for (const f of readdirSync(dir)) await real.remove(f);
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.user.createMany({ data: ['emp', 'other'].map((id) => ({ id, email: `${id}@claimflow.test`, name: id, role: 'employee' as never, passwordHash })) });
  await mkClaim('c1', 'emp'); await mkClaim('sub', 'emp', 'submitted'); await mkClaim('oth', 'other'); await mkClaim('c2', 'emp');
  out.length = 0;
}
before(async () => {
  await seed();
  srv = createApp({ log: createLogger({ write: (s) => out.push(s) }), deps: { prisma, clock, mailer: {} as never, publicBaseUrl: 'http://app.test', receipts: proxy } }).listen(0, '127.0.0.1');
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
const up = (s: S | null, body: BodyInit | null, h: Record<string, string> = {}, claim = 'c1', lineId = `${claim}-l`) =>
  fetch(`${base}/api/claims/${claim}/lines/${lineId}/receipts`, { method: 'POST', headers: { ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}), 'content-type': 'image/jpeg', ...h }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
const nothing = async () => { assert.equal(await prisma.receipt.count(), 0); assert.deepEqual(readdirSync(dir), []); };
type J = Record<string, any>;

test('AC-1 each signature accepted, mime is sniffed', async () => {
  const s = await signIn('emp');
  for (const [b, m] of [[JPG, 'image/jpeg'], [PNG, 'image/png'], [PDF(), 'application/pdf']] as const) {
    const r = await up(s, b, { 'content-type': 'text/plain' }, 'c2');
    assert.equal(r.status, 201);
    const j = (await r.json()) as J;
    assert.deepEqual(Object.keys(j).sort(), ['id', 'mime', 'originalName', 'sizeBytes']);
    assert.equal(j.mime, m);
  }
  const r = await up(s, PDF(), { 'x-filename': 'a.jpg' });
  assert.equal(((await r.json()) as J).mime, 'application/pdf');
});

test('AC-2 other content and empty refused, nothing stored', async () => {
  const s = await signIn('emp');
  for (const b of ['plain text', '<html></html>', 'GIF89a....', 'PK\x03\x04zip']) {
    const r = await up(s, b, { 'x-filename': 'a.jpg' });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'receipt_invalid_type', reason: 'Receipt must be a JPEG, PNG or PDF file' });
  }
  const e = await up(s, '');
  assert.equal(e.status, 422);
  assert.equal(((await e.json()) as J).error, 'receipt_empty');
  await nothing();
});

test('AC-3 10 MB boundary, Content-Length and chunked', async () => {
  const s = await signIn('emp');
  assert.equal((await up(s, PDF(10_485_760))).status, 201);
  await prisma.receipt.deleteMany(); for (const f of readdirSync(dir)) await real.remove(f);
  const big = PDF(10_485_761);
  const r = await up(s, big);
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: 'receipt_too_large', reason: 'Receipt must be 10 MB or smaller' });
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(big.subarray(0, 5_000_000))); c.enqueue(new Uint8Array(big.subarray(5_000_000))); c.close(); } });
  const r2 = await up(s, stream);
  assert.equal(r2.status, 413);
  await nothing();
});

test('AC-4 five per line, sixth refused; concurrent 6 give exactly 5', async () => {
  const s = await signIn('emp');
  for (let i = 0; i < 5; i++) assert.equal((await up(s, PDF())).status, 201);
  const r = await up(s, PDF());
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'receipt_limit', reason: 'A line can have at most 5 receipts' });
  assert.equal(readdirSync(dir).length, 5);
  await prisma.receipt.deleteMany(); for (const f of readdirSync(dir)) await real.remove(f);
  const rs = await Promise.all(Array.from({ length: 6 }, () => up(s, PDF(), {}, 'c2')));
  assert.deepEqual(rs.map((x) => x.status).sort(), [201, 201, 201, 201, 201, 409]);
  assert.equal(await prisma.receipt.count(), 5);
  assert.equal(readdirSync(dir).length, 5);
});

test('AC-5 stored hash, key, mode, name; nothing secret in responses', async () => {
  const s = await signIn('emp');
  const body = PDF(500);
  const r = await up(s, body, { 'x-filename': '..%2F..%2Fetc%2Fpasswd' });
  const text = await r.text();
  const row = await prisma.receipt.findFirstOrThrow();
  assert.equal(row.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(row.sizeBytes, 500);
  assert.match(row.storageKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(readdirSync(dir), [row.storageKey]);
  assert.equal(statSync(join(dir, row.storageKey)).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(dir, row.storageKey)).equals(body));
  assert.equal(row.originalName, '....etcpasswd');
  assert.ok(!text.includes(row.storageKey) && !text.includes(row.sha256));
  const long = await up(s, PDF(), { 'x-filename': `${'a'.repeat(300)}%00%0A` });
  assert.equal(((await long.json()) as J).originalName.length, 200);
});

test('AC-6 wrong state, user, line, unauthenticated', async () => {
  const s = await signIn('emp');
  assert.equal((await up(s, PDF(), {}, 'sub')).status, 409);
  assert.equal((await up(s, PDF(), {}, 'oth')).status, 403);
  assert.equal((await up(s, PDF(), {}, 'c1', 'oth-l')).status, 404);
  assert.equal((await up(s, PDF(), {}, 'nope')).status, 404);
  const u = await up(null, PDF());
  assert.equal(u.status, 401);
  await nothing();
});

test('AC-7 insert failure leaves no file; IO failure is a clean 500; logs clean', async () => {
  const s = await signIn('emp');
  await prisma.$executeRawUnsafe(`CREATE TRIGGER t_fail BEFORE INSERT ON "Receipt" BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  try { assert.equal((await up(s, PDF(), { 'x-filename': 'secret-name.pdf' })).status, 500); } finally { await prisma.$executeRawUnsafe('DROP TRIGGER t_fail'); }
  await nothing();
  store = { ensureDir() {}, put: async () => { throw new Error('receipt_write_failed'); }, remove: async () => {} };
  const r = await up(s, PDF(), { 'x-filename': 'secret-name.pdf' });
  assert.equal(r.status, 500);
  const j = (await r.json()) as J;
  assert.equal(j.error, 'internal_error');
  assert.ok(!JSON.stringify(j).includes(dir) && !JSON.stringify(j).includes('secret-name'));
  const log = out.join('');
  assert.ok(!log.includes('secret-name') && !log.includes(dir));
  await nothing();
});

test('no route deletes Claim/Receipt/ClaimEvent outside the draft-delete and line paths', () => {
  const src = readFileSync('api/src/claims/service.ts', 'utf8');
  const hits = [...src.matchAll(/tx\.(claimEvent|receipt|claim)\.delete(Many)?/g)].map((m) => m[0]).sort();
  assert.deepEqual(hits, ['tx.claim.delete', 'tx.receipt.deleteMany', 'tx.receipt.deleteMany']);
});
