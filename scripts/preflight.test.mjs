import { test, expect } from 'vitest';
import net from 'node:net';
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
