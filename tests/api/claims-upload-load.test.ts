import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';
import { receiptStorage } from '../../api/src/claims/receipt-storage.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void; // collect garbage so the sampler sees live buffers only
const PW = 'correct horse battery';
const prisma = new PrismaClient();
let srv: Server, base: string;
const wipe = async () => {
  await prisma.receipt.deleteMany(); await prisma.claimLine.deleteMany(); await prisma.claim.deleteMany(); await prisma.session.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } }); await prisma.user.deleteMany();
};
before(async () => {
  await wipe();
  await prisma.user.create({ data: { id: 'emp', email: 'emp@claimflow.test', name: 'emp', role: 'employee', passwordHash: await bcrypt.hash(PW, 4) } });
  await prisma.claim.create({ data: { id: 'c1', claimantId: 'emp', title: 't', purpose: 'purpose text', status: 'draft', createdAt: new Date(), updatedAt: new Date() } });
  // 10 lines x 5 receipts allowed: one line each so the per-line cap is not hit
  for (let i = 0; i < 10; i++) await prisma.claimLine.create({ data: { id: `l${i}`, claimId: 'c1', position: i + 1, date: '2026-03-01', categoryCode: 'meals', amountCents: 100, description: 'x' } });
  srv = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date(), mailer: {} as never, publicBaseUrl: 'http://app.test', receipts: receiptStorage(mkdtempSync(join(tmpdir(), 'load-'))) } }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await wipe(); await prisma.$disconnect(); });

test('AC-8 10 parallel 10 MiB uploads: all succeed, memory growth under 100 MB', async () => {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const token = ((await pre.json()) as { csrfToken: string }).csrfToken;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: pre.headers.getSetCookie()[0].split(';')[0] }, body: JSON.stringify({ email: 'emp@claimflow.test', password: PW }) });
  const csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!.split(';')[0];
  const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10 * 1024 * 1024 - 9, 0x61)]);
  // streamed from one shared buffer so the client side holds no per-request copy
  const stream = () => { let off = 0; return new ReadableStream<Uint8Array>({ pull(c) { if (off >= body.length) return c.close(); c.enqueue(body.subarray(off, off += 65536)); } }); };
  gc();
  const base0 = process.memoryUsage();
  let peak = 0;
  const t = setInterval(() => { gc(); const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base0.heapUsed - base0.arrayBuffers); }, 5);
  const rs = await Promise.all(Array.from({ length: Number(process.env.N ?? 10) }, (_, i) => fetch(`${base}/api/claims/c1/lines/l${i}/receipts`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/pdf' }, body: stream(), duplex: 'half' } as RequestInit)));
  clearInterval(t);
  assert.deepEqual(rs.map((x) => x.status), Array(Number(process.env.N ?? 10)).fill(201));
  assert.ok(peak < 100 * 1024 * 1024, `peak growth ${(peak / 1048576).toFixed(1)} MB`);
});
