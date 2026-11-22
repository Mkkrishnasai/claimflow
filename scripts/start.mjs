// C-1 start orchestrator. Plain ES2020 JS; no dependency import before the Node check.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20 || major >= 23) {
  console.error(`Unsupported Node ${process.version}: need >=20 <23`);
  process.exit(1);
}

const { default: dotenv } = await import('dotenv');
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env', quiet: true, override: false });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const bin = (n) => `node_modules/.bin/${n}`;
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' };

function step(cmd, args) {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
step(bin('prisma'), ['migrate', 'deploy']);
step('npm', ['run', 'seed', '--silent']);

const children = [
  ['web', bin('vite'), ['--config', 'web/vite.config.ts', 'web']],
  ['api', bin('tsx'), ['api/src/server.ts']],
  ['mailpit', 'mailpit', ['--smtp', '127.0.0.1:1025', '--listen', '127.0.0.1:8025']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('error', (e) => fail(`${name} failed to start: ${e.message}`));
  p.on('exit', (code) => fail(`${name} exited (${code})`));
  return p;
});

function kill(sig) {
  for (const p of children) try { process.kill(-p.pid, sig); } catch {}
}
function fail(msg) {
  console.error(msg);
  kill('SIGTERM');
  setTimeout(() => { kill('SIGKILL'); process.exit(1); }, 5000).unref();
  process.exitCode = 1;
}

const up = (port) => new Promise((ok) => {
  const s = net.connect(port, '127.0.0.1').once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
});
for (const port of [5173, 3001, 8025, 1025]) {
  while (!(await up(port))) await new Promise((r) => setTimeout(r, 250));
}
console.log('Ready: web http://localhost:5173, api http://localhost:3001, mailpit http://localhost:8025');
