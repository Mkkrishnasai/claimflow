import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tcp = (port: number) => new Promise<boolean>((ok) => {
  const s = net.connect(port, '127.0.0.1').once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
});

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
  // 2>&1 through one pipe so migrate output and the seed refusal keep their real order
  const r = spawnSync('sh', ['-c', 'npm start --silent 2>&1'], { env: run(envFile(base(db)), { DATABASE_URL: `file:${db}` }), encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  const seedAt = r.stdout.search(/SEED_PASSWORD_MISSING/);
  assert.ok(seedAt >= 0, r.stdout);
  const migrateAt = r.stdout.search(/migrat/i);
  assert.ok(migrateAt >= 0 && migrateAt < seedAt, `migrate output must precede seed refusal\n${r.stdout}`);
  // ponytail: post-exit refusal only proves nothing is left listening, not that none was ever spawned
  for (const p of [5173, 3001]) assert.equal(await fetch(`http://127.0.0.1:${p}/`).then(() => true, () => false), false);
});

test('AC-3: DATABASE_URL unset -> non-zero naming it, no seed', () => {
  const r = spawnSync('npm', ['start', '--silent'], { env: run('/dev/null'), encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /DATABASE_URL/);
  assert.doesNotMatch(r.stdout + r.stderr, /SEED_/);
});

test('AC-1/4/5: cold start, re-run idempotent, test routes absent', async () => {
  // required tooling: fail loudly, never skip
  assert.equal(spawnSync('which', ['mailpit']).status, 0, 'mailpit must be on PATH to run the startup tests');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'db-')), 'b.db');
  const envPath = envFile([...base(dbPath), 'SEED_PASSWORD=e2e-seed-pw']);
  const rows = async () => {
    const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    try { return await p.user.findMany({ orderBy: { email: 'asc' } }); } finally { await p.$disconnect(); }
  };
  let snapshot: Awaited<ReturnType<typeof rows>> | undefined;
  for (const round of [1, 2]) {
    if (round === 1) rmSync('node_modules/.vite', { recursive: true, force: true });
    const proc = spawn('npm', ['start', '--silent'], { env: run(envPath), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => (out += d)); proc.stderr!.on('data', (d) => (out += d));
    const exited = new Promise((r) => proc.once('exit', r));
    try {
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 60_000 && !ok) {
        ok = await Promise.all([
          ...['5173/', '3001/health', '8025/'].map((u) => fetch(`http://127.0.0.1:${u}`).then((r) => r.status === 200, () => false)),
          tcp(1025),
        ]).then((a) => a.every(Boolean));
        if (!ok) await sleep(250);
      }
      assert.ok(ok, `services reachable within 60 s\n${out}`);
      assert.deepEqual(await (await fetch('http://127.0.0.1:3001/health')).json(), { status: 'ok' });
      assert.match(await (await fetch('http://127.0.0.1:5173/')).text(), /id="root"/);
      assert.equal(await tcp(1025), true, 'SMTP 1025 accepts TCP');
      const entry = await fetch('http://127.0.0.1:5173/src/main.tsx');
      assert.equal(entry.status, 200);
      assert.match(await entry.text(), /App/);
      const now = await rows();
      assert.equal(now.length, 5);
      if (round === 1) snapshot = now; else assert.deepEqual(now, snapshot, 'all seeded rows incl. passwordHash unchanged after re-run');
      assert.equal((await fetch('http://127.0.0.1:3001/__test/echo', { method: 'POST' })).status, 404);
      assert.equal((await fetch('http://127.0.0.1:3001/__test/error')).status, 404);
    } finally {
      // only the process group this test spawned; start.mjs tears down its own children
      try { process.kill(-proc.pid!, 'SIGINT'); } catch {}
      await Promise.race([exited, sleep(10_000)]);
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch {}
    }
  }
  assert.ok(existsSync(dbPath));
});
