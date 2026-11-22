import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = spawnSync('which', ['mailpit']).status !== 0 && 'mailpit not on PATH';
const up = (port: number) => new Promise<boolean>((ok) => {
  const s = net.connect(port, '127.0.0.1').once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
});
async function until(cond: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(250); }
  return false;
}
const ready = () => until(async () => (await Promise.all([5173, 3001, 8025, 1025].map(up))).every(Boolean), 60_000);

function launch(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const envPath = join(dir, 'env');
  writeFileSync(envPath, `DATABASE_URL=file:${join(dir, 'a.db')}\nSMTP_HOST=localhost\nSMTP_PORT=1025\nSEED_PASSWORD=e2e-seed-pw\n`);
  const env = { ...process.env, DOTENV_CONFIG_PATH: envPath, DATABASE_URL: '', SEED_PASSWORD: '', ...extra };
  const proc = spawn('node', ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d)); proc.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  const within = (ms: number) => Promise.race([exited, sleep(ms).then(() => 'timeout')]);
  const cleanup = async () => { proc.kill('SIGTERM'); await within(10_000); proc.kill('SIGKILL'); };
  return { proc, within, output: () => out, cleanup };
}
async function assertFreed(ports: number[]) {
  for (const p of ports) assert.equal(await up(p), false, `port ${p} freed`);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`AC-1: ${sig} frees every port and exits 0`, { skip }, async () => {
    const { proc, within, output, cleanup } = launch();
    try {
      assert.ok(await ready(), `services up\n${output()}`);
      proc.kill(sig);
      assert.equal(await within(10_000), 0);
      await assertFreed([5173, 3001, 1025, 8025]);
    } finally { await cleanup(); }
  });
}

test('AC-1: MAILPIT_EXTERNAL=1 frees 5173/3001, external Mailpit survives', { skip }, async () => {
  const mp: ChildProcess = spawn('mailpit', ['--smtp', '127.0.0.1:1025', '--listen', '127.0.0.1:8025'], { stdio: 'ignore' });
  const { proc, within, output, cleanup } = launch({ MAILPIT_EXTERNAL: '1' });
  try {
    assert.ok(await ready(), `services up\n${output()}`);
    proc.kill('SIGINT');
    assert.equal(await within(10_000), 0);
    await assertFreed([5173, 3001]);
    assert.equal(await up(8025), true, 'external mailpit still up');
  } finally { await cleanup(); mp.kill('SIGKILL'); }
});

test('AC-2: a service dying tears the rest down and exits 1', { skip }, async () => {
  const { proc, within, output, cleanup } = launch();
  try {
    assert.ok(await ready(), `services up\n${output()}`);
    spawnSync('pkill', ['-f', 'mailpit --smtp 127.0.0.1:1025']);
    assert.equal(await within(10_000), 1);
    await assertFreed([5173, 3001, 1025, 8025]);
  } finally { await cleanup(); }
});

test('AC-2: readiness timeout exits 1 and stops services', { skip }, async () => {
  const { proc, within, output, cleanup } = launch({ START_TIMEOUT_MS: '1' });
  try {
    assert.equal(await within(30_000), 1);
    await assertFreed([5173, 3001, 1025, 8025]);
  } finally { await cleanup(); }
});
