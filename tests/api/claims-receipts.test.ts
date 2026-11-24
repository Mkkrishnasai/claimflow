import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
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
const proxy: ReceiptStore = { ensureDir: () => real.ensureDir(), put: (b) => store.put(b), remove: (k) => store.remove(k), open: (k) => store.open(k) };
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
  store = { ensureDir() {}, put: async () => { throw new Error('receipt_write_failed'); }, remove: async () => {}, open: real.open };
  const r = await up(s, PDF(), { 'x-filename': 'secret-name.pdf' });
  assert.equal(r.status, 500);
  const j = (await r.json()) as J;
  assert.equal(j.error, 'internal_error');
  assert.ok(!JSON.stringify(j).includes(dir) && !JSON.stringify(j).includes('secret-name'));
  const log = out.join('');
  assert.ok(!log.includes('secret-name') && !log.includes(dir));
  await nothing();
});

const get = (s: S | null, claim: string, rid: string) => fetch(`${base}/api/claims/${claim}/receipts/${rid}`, { headers: s ? { cookie: s.cookie } : {} });
const del = (s: S, claim: string, rid: string) => fetch(`${base}/api/claims/${claim}/receipts/${rid}`, { method: 'DELETE', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
const rcpt = async (s: S, claim: string) => ((await (await up(s, PDF(64), {}, claim)).json()) as J).id as string;
const ids = async (...u: [string, string, string | null][]) => prisma.user.createMany({ data: u.map(([id, role, managerId]) => ({ id, email: `${id}@claimflow.test`, name: id, role: role as never, managerId, passwordHash: bcrypt.hashSync(PW, 4) })) });

test('S5 AC-1/2/4 download: allowed readers, refusals, hierarchy change', async () => {
  await prisma.user.update({ where: { id: 'emp' }, data: { managerId: null } });
  await ids(['m3', 'manager', null], ['m2', 'manager', 'm3'], ['m1', 'manager', 'm2'], ['m0', 'manager', 'm1'], ['fin', 'finance', null], ['adm', 'admin', null], ['mx', 'manager', null]);
  await prisma.user.update({ where: { id: 'emp' }, data: { managerId: 'm1' } });
  const e = await signIn('emp');
  const rid = await rcpt(e, 'c1');
  await prisma.claim.update({ where: { id: 'c1' }, data: { status: 'submitted' } });
  const body = PDF(64);
  for (const u of ['emp', 'm1', 'm2', 'fin']) {
    const r = await get(await signIn(u), 'c1', rid);
    assert.equal(r.status, 200, u);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(body));
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-length'), '64');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('content-disposition'), 'inline');
    assert.equal(r.headers.get('content-security-policy'), 'sandbox'); // CR-1
    assert.equal(r.headers.get('accept-ranges'), null);
  }
  assert.equal((await get(null, 'c1', rid)).status, 401);
  for (const u of ['other', 'm3', 'mx', 'adm']) assert.equal((await get(await signIn(u), 'c1', rid)).status, 403, u);
  assert.equal((await get(await signIn('fin'), 'c1', 'nope')).status, 404);
  assert.equal((await get(await signIn('fin'), 'sub', rid)).status, 404);
  await prisma.claim.update({ where: { id: 'c1' }, data: { status: 'draft' } });
  assert.equal((await get(await signIn('fin'), 'c1', rid)).status, 403);
  await prisma.claim.update({ where: { id: 'c1' }, data: { status: 'submitted' } });
  await prisma.user.update({ where: { id: 'emp' }, data: { managerId: 'mx' } });
  assert.equal((await get(await signIn('m1'), 'c1', rid)).status, 403);
});

test('S5 AC-3 no public URL', async () => {
  const e = await signIn('emp');
  await rcpt(e, 'c1');
  const k = (await prisma.receipt.findFirstOrThrow()).storageKey;
  for (const p of [`/receipts/${k}`, `/uploads/${k}`, `/api/receipts/${k}`]) assert.ok([401, 404].includes((await fetch(base + p)).status), p);
  const j = await (await fetch(`${base}/api/claims/c1`, { headers: { cookie: e.cookie } })).text();
  assert.ok(!j.includes(k) && !j.includes('storageKey') && !j.includes('/receipts/'));
});

test('S5 AC-5 delete receipt only while editable', async () => {
  const e = await signIn('emp');
  const a = await rcpt(e, 'c1'), b = await rcpt(e, 'c2');
  await prisma.claim.update({ where: { id: 'c2' }, data: { status: 'submitted' } });
  assert.equal((await del(e, 'c1', a)).status, 204);
  assert.equal((await del(e, 'c1', a)).status, 404);
  const r = await del(e, 'c2', b);
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as J).error, 'claim_not_editable');
  assert.equal(await prisma.receipt.count(), 1);
  assert.equal(readdirSync(dir).length, 1);
});

test('S5 AC-6 line/claim delete removes files; removal failure still 204 with count only', async () => {
  const e = await signIn('emp');
  for (let i = 0; i < 2; i++) await rcpt(e, 'c1');
  const call = (path: string) => fetch(`${base}/api/claims/${path}`, { method: 'DELETE', headers: { cookie: e.cookie, 'x-csrf-token': e.csrf } });
  assert.equal((await call('c1/lines/c1-l')).status, 204);
  assert.equal(await prisma.receipt.count(), 0);
  assert.deepEqual(readdirSync(dir), []);
  for (let i = 0; i < 3; i++) await rcpt(e, 'c2');
  store = { ...real, remove: async () => { throw new Error('/secret/path'); } };
  out.length = 0;
  assert.equal((await call('c2')).status, 204);
  assert.equal(await prisma.receipt.count(), 0);
  const log = out.join('');
  assert.match(log, /"orphanFiles":3/);
  assert.ok(!log.includes('/secret/path'));
  store = real;
});

test('S5 AC-7 missing file is a plain 500', async () => {
  const e = await signIn('emp');
  const rid = await rcpt(e, 'c1');
  for (const f of readdirSync(dir)) await real.remove(f);
  const r = await get(e, 'c1', rid);
  assert.equal(r.status, 500);
  const t = await r.text();
  assert.equal((JSON.parse(t) as J).error, 'internal_error');
  assert.ok(!t.includes(dir));
  assert.equal(r.headers.get('content-disposition'), null);
});

test('no route deletes Claim/Receipt/ClaimEvent outside the draft-delete and line paths', () => {
  const src = readFileSync('api/src/claims/service.ts', 'utf8');
  const hits = [...src.matchAll(/tx\.(claimEvent|receipt|claim)\.delete(Many)?/g)].map((m) => m[0]).sort();
  assert.deepEqual(hits, ['tx.claim.delete', 'tx.receipt.delete', 'tx.receipt.deleteMany', 'tx.receipt.deleteMany']);
});

test('CR-1 a stalled upload body times out and frees its slot', async () => {
  process.env.RECEIPT_BODY_TIMEOUT_MS = '300';
  try {
    const s = await signIn('emp');
    const port = Number(new URL(base).port);
    // 4 = SLOTS: stalled bodies that announce 100 bytes and send 10
    const socks = await Promise.all(Array.from({ length: 4 }, () => new Promise<net.Socket>((res) => {
      const k = net.connect(port, '127.0.0.1', () => {
        k.write(`POST /api/claims/c1/lines/c1-l/receipts HTTP/1.1\r\nHost: x\r\nCookie: ${s.cookie}\r\nX-CSRF-Token: ${s.csrf}\r\nContent-Type: image/jpeg\r\nContent-Length: 100\r\n\r\n`);
        k.write(JPG);
        res(k);
      });
      k.on('error', () => {});
    })));
    const r = await up(s, PDF(), {}, 'c2'); // would wait forever for a slot without the timeout
    assert.equal(r.status, 201);
    socks.forEach((k) => k.destroy());
  } finally { delete process.env.RECEIPT_BODY_TIMEOUT_MS; }
});
