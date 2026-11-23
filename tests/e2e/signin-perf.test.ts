import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BASE = 'http://127.0.0.1:3001';
const PW = 'correct horse battery';

test('AC-2 sign-in p95 <= 1000 ms over 50 sequential sign-ins', async () => {
  const db = new PrismaClient({ datasourceUrl: 'file:./test.db' });
  const proc = spawn('npm run -s start:api:test', { shell: true, detached: true, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
      assert.ok(i < 100, 'server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    await db.session.deleteMany();
    await db.user.deleteMany();
    await db.user.create({ data: { email: 'perf@claimflow.test', name: 'Perf', role: 'employee', passwordHash: await bcrypt.hash(PW, 12) } });
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const c = await fetch(`${BASE}/api/auth/csrf`);
      const token = ((await c.json()) as { csrfToken: string }).csrfToken;
      const t = performance.now();
      const r = await fetch(`${BASE}/api/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: c.headers.getSetCookie()[0].split(';')[0] },
        body: JSON.stringify({ email: 'perf@claimflow.test', password: PW }),
      });
      ms.push(performance.now() - t);
      assert.equal(r.status, 200);
    }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.ceil(0.95 * ms.length) - 1];
    console.log(`sign-in p95 = ${p95.toFixed(0)} ms (max ${ms.at(-1)!.toFixed(0)})`);
    assert.ok(p95 <= 1000, `p95 ${p95}`);
  } finally {
    await db.user.deleteMany().catch(() => {});
    await db.$disconnect();
    try { process.kill(-proc.pid!, 'SIGTERM'); } catch {}
  }
});
