import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasMailpit = spawnSync('which', ['mailpit']).status === 0;

function envFile(lines: string[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'start-')), 'env');
  writeFileSync(f, lines.join('\n'));
  return f;
}
const base = (db: string) => [`DATABASE_URL=file:${db}`, 'SMTP_HOST=localhost', 'SMTP_PORT=1025'];

function run(envPath: string, extra: Record<string, string> = {}) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: envPath, ...extra };
  // empty (not deleted): Prisma client would otherwise reload a repo-root .env
  env.SEED_PASSWORD = ''; env.DATABASE_URL = '';
  return Object.assign(env, extra);
}

test('AC-2: SEED_PASSWORD unset -> non-zero, seed code, no service bound', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'db-')), 'a.db');
  const r = spawnSync('npm', ['start', '--silent'], { env: run(envFile(base(db)), { DATABASE_URL: `file:${db}` }), encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /SEED_PASSWORD_MISSING/);
  for (const p of [5173, 3001]) assert.equal(await fetch(`http://127.0.0.1:${p}/`).then(() => true, () => false), false);
});

test('AC-3: DATABASE_URL unset -> non-zero naming it, no seed', () => {
  const r = spawnSync('npm', ['start', '--silent'], { env: run('/dev/null'), encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /DATABASE_URL/);
  assert.doesNotMatch(r.stdout + r.stderr, /SEED_/);
});

test('AC-1/4/5: cold start, re-run idempotent, test routes absent', { skip: !hasMailpit && 'mailpit not on PATH' }, async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'db-')), 'b.db');
  const envPath = envFile([...base(dbPath), 'SEED_PASSWORD=e2e-seed-pw']);
  const count = async () => {
    const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    try { return await p.user.count(); } finally { await p.$disconnect(); }
  };
  for (const round of [1, 2]) {
    if (round === 1) rmSync('node_modules/.vite', { recursive: true, force: true });
    const proc = spawn('npm', ['start', '--silent'], { env: run(envPath), detached: true, stdio: 'ignore' });
    try {
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 60_000 && !ok) {
        ok = await Promise.all(['5173/', '3001/health', '8025/'].map((u) => fetch(`http://127.0.0.1:${u}`).then((r) => r.ok, () => false))).then((a) => a.every(Boolean));
        if (!ok) await sleep(250);
      }
      assert.ok(ok, 'services reachable within 60 s');
      assert.deepEqual(await (await fetch('http://127.0.0.1:3001/health')).json(), { status: 'ok' });
      assert.match(await (await fetch('http://127.0.0.1:5173/')).text(), /id="root"/);
      assert.equal(await count(), 5);
      assert.equal((await fetch('http://127.0.0.1:3001/__test/echo', { method: 'POST' })).status, 404);
      assert.equal((await fetch('http://127.0.0.1:3001/__test/error')).status, 404);
    } finally {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch {}
      spawnSync('pkill', ['-f', 'node_modules/.bin/(vite|tsx)|mailpit']);
      await sleep(1500);
    }
  }
  assert.ok(existsSync(dbPath));
});
