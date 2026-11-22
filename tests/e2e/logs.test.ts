import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  if (!existsSync(devDb)) writeFileSync(devDb, 'placeholder-dev-db');
  const hash = () => createHash('sha256').update(readFileSync(devDb)).digest('hex');
  const before = hash();
  const s = await start(['npm', 'run', '-s', 'start:api:test']);
  try {
    // AC-1
    const base = lines(s.out).length;
    const r1 = await fetch(`${BASE}/health`);
    await settle();
    let rl = reqLines(s.out);
    const health = rl.filter((o) => o.path === '/health').pop();
    assert.equal(r1.status, 200);
    for (const k of REQUIRED) assert.ok(health[k] !== undefined && health[k] !== '', k);
    assert.equal(health.level, 'info');
    assert.equal(health.method, 'GET');
    assert.equal(health.status, 200);
    assert.ok(!Number.isNaN(Date.parse(health.timestamp)) && health.timestamp.endsWith('Z'));
    assert.ok(lines(s.out).length > base); // sanity

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
      if (o.status >= 500) assert.equal(o.level, 'error');
      else if (o.status >= 400) assert.equal(o.level, 'warn');
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
