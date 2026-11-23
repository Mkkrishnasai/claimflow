// C-1 start orchestrator. Plain ES2020 JS; no dependency import before the Node check.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

import { nodeVersionOk, preflight } from './preflight.mjs';

if (!nodeVersionOk(process.versions.node)) {
  console.error(`Node >=20 <23 required, found ${process.version}`);
  process.exit(1);
}

// Empty string == unset (FR-3), so it must not block dotenv's non-overriding load.
for (const k of Object.keys(process.env)) if (process.env[k] === '') delete process.env[k];
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env', quiet: true, override: false });

// One pass: DATABASE_URL absence is reported together with the ordinary preflight failures.
const problems = [...(process.env.DATABASE_URL ? [] : ['DATABASE_URL is not set']), ...(await preflight(process.env))];
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const external = process.env.MAILPIT_EXTERNAL === '1';
const bin = (n) => `node_modules/.bin/${n}`;
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' };

// A closed terminal makes stdout/stderr writes fail (EIO/EPIPE); that must never abort teardown.
for (const s of [process.stdout, process.stderr]) s.on('error', () => {});

// Signals sent to this process during migrate/seed are deferred until the step returns (README).
function step(cmd, args) {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
step(bin('prisma'), ['migrate', 'deploy']);
step('npm', ['run', 'seed', '--silent']);

let stopping = false;
const children = [
  ['web', bin('vite'), ['--config', 'web/vite.config.ts', 'web']],
  ['api', bin('tsx'), ['api/src/server.ts']],
  ...(external ? [] : [['mailpit', 'mailpit', ['--smtp', '127.0.0.1:1025', '--listen', '127.0.0.1:8025']]]),
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('error', (e) => stop(1, `${name} failed to start: ${e.message}`));
  p.on('exit', (code, sig) => stop(1, `${name} exited (${code ?? sig})`));
  return p;
});

// Only this launch's own child process groups; a group already gone is never signalled again.
const alive = (p) => { try { return process.kill(-p.pid, 0); } catch { return false; } };
function kill(sig) {
  for (const p of children) if (alive(p)) try { process.kill(-p.pid, sig); } catch {}
}
const groupAlive = () => children.some(alive);

// SIGTERM every child process group, wait up to 5 s for them to vanish, then SIGKILL.
async function stop(code, msg) {
  if (stopping) return;
  stopping = true;
  if (msg) console.error(msg);
  kill('SIGTERM');
  for (let i = 0; i < 50 && groupAlive(); i++) await new Promise((r) => setTimeout(r, 100));
  kill('SIGKILL');
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(0));

const up = (port) => new Promise((ok) => {
  const s = net.connect(port, '127.0.0.1').once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
});
const deadline = Date.now() + (Number(process.env.START_TIMEOUT_MS) || 60000);
// Ready == HTTP 200 (API /health, web /, Mailpit UI /) plus SMTP accepting TCP on 1025.
const http200 = (url) => fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) })
  .then((r) => r.status === 200, () => false);
const services = [
  ['web', 5173, () => http200('http://127.0.0.1:5173/')],
  ['api', 3001, () => http200('http://127.0.0.1:3001/health')],
  ['mailpit', 8025, () => http200('http://127.0.0.1:8025/')],
  ['mailpit', 1025, () => up(1025)],
];
for (const [name, port, probe] of services) {
  while (!stopping && !(await probe())) {
    await new Promise((r) => setTimeout(r, 250));
    if (Date.now() > deadline) await stop(1, `${name} not ready on port ${port} within START_TIMEOUT_MS`);
  }
  // A probe that turns healthy late must still honour the single overall deadline.
  if (!stopping && Date.now() > deadline) await stop(1, `${name} not ready on port ${port} within START_TIMEOUT_MS`);
}
if (!stopping) console.log('Ready: web http://localhost:5173, api http://localhost:3001, mailpit http://localhost:8025');
