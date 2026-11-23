import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../api/src/config.js';
import { withWrite } from '../../api/src/db.js';
import { HttpError, errorHandler } from '../../api/src/middleware.js';
import { readFileSync } from 'node:fs';

const ok = { DATABASE_URL: 'file:./x.db', SMTP_HOST: 'h', SMTP_PORT: '1025' };

test('PUBLIC_BASE_URL default, empty, trimmed, invalid', () => {
  assert.equal(loadConfig(ok).publicBaseUrl, 'http://127.0.0.1:5173');
  assert.equal(loadConfig({ ...ok, PUBLIC_BASE_URL: '' }).publicBaseUrl, 'http://127.0.0.1:5173');
  assert.equal(loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://app.example.com/' }).publicBaseUrl, 'https://app.example.com');
  assert.throws(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'not-a-url' }), (e: unknown) => e instanceof ConfigError && e.variable === 'PUBLIC_BASE_URL');
});

test('.env.example placeholders', () => {
  const t = readFileSync('.env.example', 'utf8');
  assert.match(t, /^PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:5173$/m);
  assert.match(t, /^SMTP_HOST=127\.0\.0\.1$/m);
});

test('withWrite serialises writes', async () => {
  const log: string[] = [];
  const prisma = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never;
  const job = (n: string, ms: number) => withWrite(prisma, async () => {
    log.push(`start ${n}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${n}`);
  });
  await Promise.all([job('a', 30), job('b', 0)]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
  await assert.rejects(withWrite(prisma, async () => { throw new Error('x'); }));
  await withWrite(prisma, async () => 1); // lock released after failure
});

test('errorHandler maps HttpError', () => {
  const call = (err: unknown) => {
    const r: { status?: number; body?: unknown; locals: Record<string, unknown>; headersSent: boolean } = { locals: {}, headersSent: false };
    const res = { locals: r.locals, headersSent: false, status(s: number) { r.status = s; return this; }, json(b: unknown) { r.body = b; } };
    (errorHandler as (...a: unknown[]) => void)(err, {}, res, () => {});
    return r;
  };
  const a = call(new HttpError(409, 'hierarchy_violation', 'Manager would create a loop'));
  assert.equal(a.status, 409);
  assert.deepEqual(a.body, { error: 'hierarchy_violation', reason: 'Manager would create a loop' });
  const b = call(new HttpError(502, 'smtp_unavailable', 'secret'));
  assert.equal(b.status, 502);
  assert.deepEqual(b.body, { error: 'smtp_unavailable' });
  assert.ok(b.locals.error);
});
