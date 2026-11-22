// C-1 start orchestrator. Plain ES2020 JS; no dependency import before the Node check.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

import { nodeVersionOk, preflight } from './preflight.mjs';

if (!nodeVersionOk(process.versions.node)) {
  console.error(`Node >=20 <23 required, found ${process.version}`);
  process.exit(1);
}

const { default: dotenv } = await import('dotenv');
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env', quiet: true, override: false });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const problems = await preflight(process.env);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const external = process.env.MAILPIT_EXTERNAL === '1';
const bin = (n) => `node_modules/.bin/${n}`;
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' };

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

function kill(sig) {
  for (const p of children) try { process.kill(-p.pid, sig); } catch {}
}
const groupAlive = () => children.some((p) => { try { return process.kill(-p.pid, 0); } catch { return false; } });

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
const services = [[5173, 'web'], [3001, 'api'], [8025, 'mailpit'], [1025, 'mailpit']];
for (const [port, name] of services) {
  while (!stopping && !(await up(port))) {
    if (Date.now() > deadline) await stop(1, `${name} not ready on port ${port} within START_TIMEOUT_MS`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
if (!stopping) console.log('Ready: web http://localhost:5173, api http://localhost:3001, mailpit http://localhost:8025');
