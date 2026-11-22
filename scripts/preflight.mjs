// C-2 preflight. Node builtins only (runs before dependencies are trusted).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export function nodeVersionOk(version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return major >= 20 && major < 23;
}

const connects = (port, host, timeout) => new Promise((ok) => {
  const s = net.connect({ port, host });
  s.setTimeout(timeout);
  s.once('connect', () => (s.destroy(), ok(true)));
  s.once('timeout', () => (s.destroy(), ok(false)));
  s.once('error', () => ok(false));
});

async function httpOk(port, timeout) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeout) })).status === 200;
  } catch { return false; }
}

const onPath = (env) => (env.PATH ?? '').split(path.delimiter).some((d) => {
  try { fs.accessSync(path.join(d, 'mailpit'), fs.constants.X_OK); return true; } catch { return false; }
});

// Returns failure messages; empty array = pass. `version` is injectable for tests.
export async function preflight(env, version = process.versions.node) {
  const fails = [];
  if (!nodeVersionOk(version)) fails.push(`Node >=20 <23 required, found v${version}`);
  const external = env.MAILPIT_EXTERNAL === '1';
  const ports = external ? [5173, 3001] : [5173, 3001, 1025, 8025];
  const busy = await Promise.all(ports.map(async (p) =>
    (await Promise.all([connects(p, '127.0.0.1', 300), connects(p, '::1', 300)])).some(Boolean)));
  ports.forEach((p, i) => busy[i] && fails.push(`Port ${p} is already in use`));
  if (external) {
    if (!(await connects(1025, '127.0.0.1', 1000))) fails.push('MAILPIT_EXTERNAL=1 but nothing accepts TCP on port 1025');
    if (!(await httpOk(8025, 2000))) fails.push('MAILPIT_EXTERNAL=1 but nothing answers on port 8025');
  } else if (!onPath(env)) {
    fails.push('mailpit not found on PATH: install it or set MAILPIT_EXTERNAL=1');
  }
  return fails;
}
