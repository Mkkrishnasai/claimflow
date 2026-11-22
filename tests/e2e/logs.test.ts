import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://127.0.0.1:3001';
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUIRED = ['timestamp', 'level', 'method', 'path', 'status', 'duration_ms', 'requestId'];
const env = { ...process.env, SMTP_HOST: 'localhost', SMTP_PORT: '1025', DOTENV_CONFIG_PATH: '/dev/null' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Server { proc: ChildProcess; out: string; err: string; stop(): Promise<void> }

async function start(cmd: string[], extraEnv: Record<string, string> = {}): Promise<Server> {
  await new Promise<void>((res, rej) => {
    const probe = createServer().once('error', () => rej(new Error('port 3001 is occupied; stop the other server first')));
    probe.listen(3001, '127.0.0.1', () => probe.close(() => res()));
  });
  const dir = mkdtempSync(join(tmpdir(), 'logs-'));
  const outF = join(dir, 'out'), errF = join(dir, 'err');
  const proc = spawn(`${cmd.join(' ')} >${outF} 2>${errF}`, { shell: true, detached: true, env: { ...env, ...extraEnv } });
  const s: Server = {
    proc,
    get out() { return readFileSync(outF, 'utf8'); },
    get err() { return readFileSync(errF, 'utf8'); },
    async stop() {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch {}
      await sleep(500);
    },
  } as Server;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return s; } catch {}
    await sleep(200);
  }
  await s.stop();
  throw new Error(`server did not start: ${s.err}`);
}

const lines = (s: string) => s.split('\n').filter(Boolean);
const reqLines = (s: string) => lines(s).map((l) => JSON.parse(l)).filter((o) => 'requestId' in o);
const settle = () => sleep(300);

test('test mode: AC-1..AC-4, AC-6', async () => {
  const devDb = 'prisma/dev.db';
  assert.ok(existsSync(devDb), 'prisma/dev.db missing: run `npx prisma migrate deploy && npm run seed` with DATABASE_URL=file:./dev.db');
  const dev = new PrismaClient({ datasourceUrl: 'file:./dev.db' });
  try { assert.equal(await dev.user.count(), 5); } finally { await dev.$disconnect(); }
  const hash = () => createHash('sha256').update(readFileSync(devDb)).digest('hex');
  const before = hash();
  const s = await start(['npm', 'run', '-s', 'start:api:test']);
  try {
    // AC-1
    const base = reqLines(s.out).length;
    const r1 = await fetch(`${BASE}/health`);
    await settle();
    let rl = reqLines(s.out);
    assert.equal(rl.length - base, 1);
    const health = rl.filter((o) => o.path === '/health').pop();
    assert.equal(r1.status, 200);
    for (const k of REQUIRED) assert.ok(health[k] !== undefined && health[k] !== '', k);
    assert.equal(health.level, 'info');
    assert.equal(health.method, 'GET');
    assert.equal(health.status, 200);
    assert.ok(!Number.isNaN(Date.parse(health.timestamp)) && health.timestamp.endsWith('Z'));

    // AC-2
    const r2 = await fetch(`${BASE}/health`, { headers: { 'X-Request-Id': 'spoofed-1' } });
    const id = r2.headers.get('x-request-id')!;
    assert.match(id, UUID4);
    assert.notEqual(id, 'spoofed-1');
    await settle();
    assert.ok(reqLines(s.out).some((o) => o.requestId === id));

    // AC-4
    await fetch(`${BASE}/__test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"note":"BODYMARK"}' });
    await fetch(`${BASE}/health?q=QUERYMARK`);

    // AC-3: 20+ mixed requests
    for (let i = 0; i < 15; i++) await fetch(`${BASE}/health`);
    assert.equal((await fetch(`${BASE}/nope`)).status, 404);
    const bad = await fetch(`${BASE}/__test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(bad.status, 400);
    const err = await fetch(`${BASE}/__test/error?password=x&receipt=y&bankAccount=z`);
    assert.equal(err.status, 500);
    await settle();

    for (const l of lines(s.out)) assert.doesNotThrow(() => assert.equal(typeof JSON.parse(l), 'object'), l);
    rl = reqLines(s.out);
    assert.ok(rl.length >= 20);
    for (const o of rl) {
      for (const k of REQUIRED) assert.ok(o[k] !== undefined && o[k] !== '', k);
      assert.equal(typeof o.duration_ms, 'number');
      if (o.status < 400) assert.equal(o.level, 'info');
      else if (o.status >= 500) assert.equal(o.level, 'error');
      else assert.equal(o.level, 'warn');
    }
    assert.ok(rl.some((o) => o.status === 404) && rl.some((o) => o.status === 400) && rl.some((o) => o.status === 500));
    const errBody = await err.json();
    assert.deepEqual(Object.keys(errBody).sort(), ['error', 'requestId']);
    assert.equal(errBody.error, 'internal_error');
    assert.ok(rl.some((o) => o.requestId === errBody.requestId && o.status === 500));

    // AC-4
    for (const f of [s.out, s.err]) {
      assert.ok(!f.includes('BODYMARK') && !f.includes('QUERYMARK'));
    }
    assert.ok(rl.some((o) => o.path === '/health' && o.status === 200));
    assert.ok(rl.every((o) => !o.path.includes('?')));

    // AC-6
    assert.ok(existsSync('prisma/test.db'));
    const db = new PrismaClient({ datasourceUrl: 'file:./test.db' });
    try { assert.equal(await db.user.count(), 0); } finally { await db.$disconnect(); }
  } finally {
    await s.stop();
  }
  assert.equal(hash(), before);
});

test('AC-5: test routes only in test mode', async () => {
  const dev = await start(['npx', 'tsx', 'api/src/server.ts'], { NODE_ENV: 'development', DATABASE_URL: 'file:./test.db' });
  try {
    assert.equal((await fetch(`${BASE}/__test/echo`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${BASE}/__test/error`)).status, 404);
  } finally {
    await dev.stop();
  }
  const t = await start(['npm', 'run', '-s', 'start:api:test']);
  try {
    const echo = await fetch(`${BASE}/__test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(echo.status, 200);
    assert.deepEqual(await echo.json(), { ok: true });
    const e = await fetch(`${BASE}/__test/error`);
    assert.equal(e.status, 500);
    const b = await e.json();
    assert.equal(b.error, 'internal_error');
    assert.match(b.requestId, UUID4);
  } finally {
    await t.stop();
  }
});

test('S4 AC-3..AC-5: markers never reach logs; 5xx line redacted', async () => {
  const [m1, m2, m3] = ['MARK_PW_91', 'MARK_RC_92', 'MARK_BA_93'];
  const s = await start(['npm', 'run', '-s', 'start:api:test']);
  try {
    await fetch(`${BASE}/__test/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: m1, receipt: m2, bankAccount: m3 }),
    });
    const q = (a: string, b: string, c: string) => `password=${a}&receipt=${b}&bankAccount=${c}`;
    const r = await fetch(`${BASE}/__test/error?${q(m1, m2, m3)}`);
    assert.equal(r.status, 500);
    const requestId = (await r.json()).requestId;
    // AC-5: stack-shaped markers
    const stk = ['MARKER_1', 'MARKER_2', 'MARKER_3'].map((m) => `%0A%20%20%20%20at%20${m}`).join('');
    assert.equal((await fetch(`${BASE}/__test/error?${q(stk, stk, stk)}`)).status, 500);
    await settle();
    for (const m of [m1, m2, m3, 'MARKER_1', 'MARKER_2', 'MARKER_3']) {
      assert.ok(!s.out.includes(m) && !s.err.includes(m), m);
    }
    const line = reqLines(s.out).find((o) => o.requestId === requestId);
    assert.equal(line.level, 'error');
    assert.equal(line.status, 500);
    for (const k of ['password', 'receipt', 'bankAccount']) assert.equal(line.error.context[k], '[REDACTED]');
  } finally {
    await s.stop();
  }
});
