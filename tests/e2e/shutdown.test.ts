import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const ALL = [5173, 3001, 1025, 8025];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const up = (port: number) => new Promise<boolean>((ok) => {
  const s = net.connect(port, '127.0.0.1').once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
});
async function until(cond: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(250); }
  return false;
}
const ready = () => until(async () => (await Promise.all(ALL.map(up))).every(Boolean), 60_000);
async function assertFreed(ports: number[], why = 'freed') {
  for (const p of ports) assert.equal(await until(async () => !(await up(p)), 3_000), true, `port ${p} ${why}`);
}

// Required process tests never skip: a missing Mailpit or a busy fixed port is a failure.
test('precondition: mailpit is on PATH', () => {
  assert.equal(spawnSync('which', ['mailpit']).status, 0, 'mailpit must be installed to run the process tests');
});

function launch(extra: Record<string, string> = {}, pty = false) {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const envPath = join(dir, 'env');
  writeFileSync(envPath, `DATABASE_URL=file:${join(dir, 'a.db')}\nSMTP_HOST=localhost\nSMTP_PORT=1025\nSEED_PASSWORD=e2e-seed-pw\n`);
  const env = { ...process.env, DOTENV_CONFIG_PATH: envPath, DATABASE_URL: '', SEED_PASSWORD: '', ...extra };
  const cmd = ['node', 'scripts/start.mjs'];
  // `script` allocates a real PTY: BSD form on macOS, util-linux form elsewhere.
  const [bin, args] = !pty ? [cmd[0], cmd.slice(1)]
    : process.platform === 'darwin' ? ['script', ['-q', '/dev/null', ...cmd]] : ['script', ['-qec', cmd.join(' '), '/dev/null']];
  // `script` refuses Node's socket stdio: feed it through cat from a FIFO (cat exits on our close) and log to a file.
  const fifo = join(dir, 'in'), log = join(dir, 'out.log');
  let tty = -1;
  if (pty) { spawnSync('mkfifo', [fifo]); tty = openSync(fifo, 'r+'); }
  const proc = pty ? spawn('sh', ['-c', `cat "${fifo}" | "$0" "$@" > "${log}" 2>&1`, bin, ...args], { env, stdio: 'ignore' })
    : spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout?.on('data', (d) => (out += d)); proc.stderr?.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  const within = async (ms: number) => {
    let t: NodeJS.Timeout;
    const r = await Promise.race([exited, new Promise<string>((ok) => { t = setTimeout(() => ok('timeout'), ms); })]);
    clearTimeout(t!);
    return r;
  };
  const cleanup = async () => { proc.kill('SIGTERM'); await within(10_000); proc.kill('SIGKILL'); };
  return { proc, within, output: () => (pty ? readFileSync(log, 'utf8') : out), cleanup, type: (c: string) => { writeSync(tty, c); closeSync(tty); }, hangup: () => process.kill(childPid(proc.pid!, /^script /), 'SIGKILL') };
}

// Direct children of this launch's start process only; no global name matching.
function childPid(parent: number, re: RegExp) {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).stdout.toString().split('\n');
  for (const row of rows) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && Number(m[2]) === parent && re.test(m[3])) return Number(m[1]);
  }
  throw new Error(`no child of ${parent} matching ${re}`);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`AC-5: ${sig} frees every port and exits 0`, async () => {
    await assertFreed(ALL, 'free before start');
    const { proc, within, output, cleanup } = launch();
    try {
      assert.ok(await ready(), `services up\n${output()}`);
      proc.kill(sig);
      assert.equal(await within(10_000), 0, output());
      await assertFreed(ALL);
    } finally { await cleanup(); }
  });
}

test('AC-5: Ctrl-C on a real PTY frees every port and exits 0', async () => {
  await assertFreed(ALL, 'free before start');
  const { within, output, cleanup, type } = launch({}, true);
  try {
    assert.ok(await ready(), `services up\n${output()}`);
    type('\x03'); // the PTY line discipline turns this into SIGINT for the foreground group
    assert.equal(await within(10_000), 0, output());
    await assertFreed(ALL);
  } finally { await cleanup(); }
});

test('AC-5: closing the PTY (hangup) frees every port', async () => {
  await assertFreed(ALL, 'free before start');
  const { output, cleanup, hangup } = launch({}, true);
  try {
    assert.ok(await ready(), `services up\n${output()}`);
    // Killing `script` closes the PTY master: the kernel hangs up the session and it loses its terminal.
    hangup();
    assert.ok(await until(async () => !(await Promise.all(ALL.map(up))).some(Boolean), 10_000), 'ports freed after hangup');
  } finally { await cleanup(); }
});

test('AC-5: MAILPIT_EXTERNAL=1 frees 5173/3001, external Mailpit survives', async () => {
  await assertFreed(ALL, 'free before start');
  const mp: ChildProcess = spawn('mailpit', ['--smtp', '127.0.0.1:1025', '--listen', '127.0.0.1:8025'], { stdio: 'ignore' });
  const { proc, within, output, cleanup } = launch({ MAILPIT_EXTERNAL: '1' });
  try {
    assert.ok(await ready(), `services up\n${output()}`);
    proc.kill('SIGINT');
    assert.equal(await within(10_000), 0, output());
    await assertFreed([5173, 3001]);
    assert.equal(await up(8025), true, 'external mailpit still up');
  } finally { await cleanup(); mp.kill('SIGKILL'); }
});

const owned: [string, RegExp][] = [['web', /vite/], ['api', /tsx/], ['mailpit', /mailpit/]];
for (const [name, re] of owned) {
  test(`AC-2: ${name} dying tears the rest down, exits 1 and names ${name}`, async () => {
    await assertFreed(ALL, 'free before start');
    const { proc, within, output, cleanup } = launch();
    try {
      assert.ok(await ready(), `services up\n${output()}`);
      process.kill(childPid(proc.pid!, re), 'SIGKILL');
      assert.equal(await within(10_000), 1, output());
      assert.match(output(), new RegExp(`${name} exited`));
      await assertFreed(ALL);
    } finally { await cleanup(); }
  });
}

test('AC-2: readiness timeout exits 1, names the not-ready service and stops services', async () => {
  await assertFreed(ALL, 'free before start');
  const { within, output, cleanup } = launch({ START_TIMEOUT_MS: '1' });
  try {
    assert.equal(await within(30_000), 1, output());
    assert.match(output(), /web not ready on port 5173 within START_TIMEOUT_MS/);
    await assertFreed(ALL);
  } finally { await cleanup(); }
});
