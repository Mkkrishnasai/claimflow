import { test, expect } from 'vitest';
import net from 'node:net';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeVersionOk, preflight } from './preflight.mjs';

const listen = (port, host = '127.0.0.1', srv = net.createServer()) =>
  new Promise((ok) => srv.listen(port, host, () => ok(srv)));
const close = (s) => new Promise((ok) => s.close(ok));
const fakeBin = (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-')); fs.writeFileSync(path.join(d, 'mailpit'), '#!/bin/sh\n', { mode: 0o755 }); return d; })();
const withMailpit = { PATH: fakeBin };
const ver = '20.11.0'; // pin so tests don't depend on the host Node

test('nodeVersionOk', () => {
  for (const v of ['20.11.0', '22.4.0']) expect(nodeVersionOk(v)).toBe(true);
  for (const v of ['19.9.0', '23.0.0']) expect(nodeVersionOk(v)).toBe(false);
});

test('unsupported Node is named', async () => {
  const f = await preflight(withMailpit, '23.0.0');
  expect(f.some((m) => /Node >=20 <23 required, found v23\.0\.0/.test(m))).toBeTruthy();
});

test('all-free + mailpit on PATH passes', async () => {
  expect(await preflight(withMailpit, ver)).toEqual([]);
});

test('occupied ports are each named, IPv4 and IPv6', async () => {
  const servers = [await listen(5173), await listen(3001), await listen(1025), await listen(8025)];
  try {
    const f = await preflight(withMailpit, ver);
    for (const p of [5173, 3001, 1025, 8025]) expect(f.filter((m) => m.includes(String(p))).length).toBe(1);
  } finally { await Promise.all(servers.map(close)); }
  let v6;
  try { v6 = await listen(3001, '::1'); } catch { return; } // no IPv6 on host
  try { expect((await preflight(withMailpit, ver)).some((m) => m.includes('3001'))).toBeTruthy(); } finally { await close(v6); }
});

test('missing mailpit is named', async () => {
  const f = await preflight({ PATH: os.tmpdir() }, ver);
  expect(f.some((m) => /mailpit/.test(m) && /MAILPIT_EXTERNAL=1/.test(m))).toBeTruthy();
});

test('external mailpit accepted; 1025/8025 not occupied; 5173/3001 still checked', async () => {
  const smtp = await listen(1025);
  const ui = http.createServer((_, r) => r.end('ok'));
  await listen(8025, '127.0.0.1', ui);
  const env = { PATH: os.tmpdir(), MAILPIT_EXTERNAL: '1' };
  try {
    expect(await preflight(env, ver)).toEqual([]);
    const web = await listen(5173);
    try { expect((await preflight(env, ver)).some((m) => m.includes('5173'))).toBeTruthy(); } finally { await close(web); }
  } finally { await close(smtp); await close(ui); }
});

test('external mailpit not answering names 8025 and 1025', async () => {
  const f = await preflight({ PATH: os.tmpdir(), MAILPIT_EXTERNAL: '1' }, ver);
  expect(f.some((m) => m.includes('1025'))).toBeTruthy();
  expect(f.some((m) => m.includes('8025'))).toBeTruthy();
});

// --- Process-level tests of `node scripts/start.mjs`. Serial with the unit tests above
// (vitest fileParallelism:false); ports 5173/3001/1025/8025 must be free on the host.
const start = path.resolve('scripts/start.mjs');
function runStart(env, ports = []) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'throwaway.db');
  return Promise.all(ports.map((p) => listen(p))).then((servers) => new Promise((ok) => {
    const c = spawn(process.execPath, [start], {
      env: { ...env, DATABASE_URL: `file:${db}`, DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'no-such.env') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', async (code) => { await Promise.all(servers.map(close)); ok({ code, out, err, db }); });
  }));
}
const noSideEffects = (r) => {
  expect(r.out).toBe(''); // no "Ready", no migrate/seed/service output
  expect(fs.existsSync(r.db)).toBe(false); // migrate would have created the DB file
};

test('start.mjs: occupied port exits non-zero, one message per line, nothing executed', async () => {
  const r = await runStart(withMailpit, [3001]);
  expect(r.code).not.toBe(0);
  expect(r.err.trim().split('\n')).toEqual(['Port 3001 is already in use']);
  noSideEffects(r);
});

test('start.mjs: missing mailpit exits non-zero naming mailpit, nothing executed', async () => {
  const r = await runStart({ PATH: os.tmpdir() });
  expect(r.code).not.toBe(0);
  const lines = r.err.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^mailpit not found on PATH/);
  noSideEffects(r);
});

test('start.mjs: missing DATABASE_URL is aggregated with preflight failures, one per line', async () => {
  const r = await new Promise((ok) => {
    const c = spawn(process.execPath, [start], {
      env: { PATH: os.tmpdir(), DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'no-such.env') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => ok({ code, err }));
  });
  expect(r.code).not.toBe(0);
  expect(r.err.trim().split('\n')).toEqual([
    'DATABASE_URL is not set',
    expect.stringMatching(/^mailpit not found on PATH/),
  ]);
});
