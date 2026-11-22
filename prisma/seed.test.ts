import { test, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { checkSeedGuards } from './seed-guards.js';

const PW = 'test-pw-Zq81';
const dir = mkdtempSync(join(tmpdir(), 'seed-'));
const url = `file:${join(dir, 'test.db')}`;
const baseEnv = { ...process.env, DATABASE_URL: url, SEED_PASSWORD: PW, DOTENV_CONFIG_PATH: join(dir, 'none.env') } as NodeJS.ProcessEnv;
delete baseEnv.NODE_ENV;

const run = (cmd: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(cmd[0], cmd.slice(1), { env, encoding: 'utf8', shell: false });
const seed = (env: NodeJS.ProcessEnv) => run(['node', '--import', 'tsx', 'prisma/seed.ts'], env);
const migrate = () => run(['npx', 'prisma', 'migrate', 'deploy'], baseEnv);
const db = () => new PrismaClient({ datasources: { db: { url } } });

beforeAll(() => expect(migrate().status).toBe(0));

test('AC-1 migrate deploy is idempotent', () => {
  const r = migrate();
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/No pending migrations/);
});

test('AC-2/4 seed creates exact hierarchy with cost>=12 hashes', async () => {
  expect(seed(baseEnv).status).toBe(0);
  const p = db();
  const users = await p.user.findMany();
  const by = Object.fromEntries(users.map((u) => [u.email, u]));
  expect(users.length).toBe(5);
  const sm = by['senior.manager@claimflow.test'], m = by['manager@claimflow.test'];
  expect(sm.managerId).toBe(null);
  expect(m.role).toBe('manager'); expect(m.managerId).toBe(sm.id);
  expect(by['employee@claimflow.test'].role).toBe('employee');
  expect(by['employee@claimflow.test'].managerId).toBe(m.id);
  expect(by['finance@claimflow.test'].role).toBe('finance');
  expect(by['admin@claimflow.test'].role).toBe('admin');
  expect(by['finance@claimflow.test'].managerId).toBe(sm.id);
  expect(by['admin@claimflow.test'].managerId).toBe(sm.id);
  for (const u of users) {
    expect(Number(/^\$2[aby]\$(\d\d)\$/.exec(u.passwordHash)?.[1])).toBeGreaterThanOrEqual(12);
    expect(await bcrypt.compare(PW, u.passwordHash)).toBeTruthy();
  }
  for (const f of ['seed.ts', 'seed-guards.ts']) expect(!readFileSync(join('prisma', f), 'utf8').includes(PW)).toBeTruthy();
  await p.$disconnect();
});

test('AC-3 re-seed does not overwrite', async () => {
  const p = db();
  await p.user.update({ where: { email: 'finance@claimflow.test' }, data: { role: 'admin' } });
  expect(seed(baseEnv).status).toBe(0);
  expect(await p.user.count()).toBe(5);
  expect((await p.user.findUniqueOrThrow({ where: { email: 'finance@claimflow.test' } })).role).toBe('admin');
  await p.$disconnect();
});

test('AC-5 guards order (pure)', () => {
  const g = checkSeedGuards;
  expect(g({ NODE_ENV: 'production' })?.code).toBe('SEED_REFUSED_PRODUCTION');
  expect(g({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x' })?.code).toBe('SEED_REFUSED_PRODUCTION');
  expect(g({ DATABASE_URL: 'postgresql://x', SEED_PASSWORD: 'p' })?.code).toBe('SEED_REFUSED_NON_LOCAL_DB');
  const unset = g({ SEED_PASSWORD: 'p' });
  expect(unset?.code).toBe('SEED_REFUSED_NON_LOCAL_DB');
  expect(unset!.message).toMatch(/DATABASE_URL/);
  expect(g({ DATABASE_URL: 'file:x' })?.code).toBe('SEED_PASSWORD_MISSING');
  expect(g({ DATABASE_URL: 'file:x', SEED_PASSWORD: '' })?.code).toBe('SEED_PASSWORD_MISSING');
  expect(g({ DATABASE_URL: 'file:x', SEED_PASSWORD: 'p' })).toBe(null);
});

test('AC-5 seed process refuses and creates 0 users', async () => {
  const fresh = `file:${join(dir, 'fresh.db')}`;
  const e = (o: Record<string, string | undefined>) => {
    const env = { ...baseEnv, DATABASE_URL: fresh, ...o } as NodeJS.ProcessEnv;
    for (const k of Object.keys(o)) if (o[k] === undefined) delete env[k];
    return env;
  };
  let r = seed(e({ NODE_ENV: 'production', SEED_PASSWORD: undefined }));
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/SEED_REFUSED_PRODUCTION/);
  expect(r.stderr).not.toMatch(/SEED_PASSWORD_MISSING/);
  r = seed(e({ DATABASE_URL: 'postgresql://x' }));
  expect(r.stderr).toMatch(/SEED_REFUSED_NON_LOCAL_DB/);
  r = seed(e({ DATABASE_URL: undefined }));
  expect(r.stderr).toMatch(/SEED_REFUSED_NON_LOCAL_DB[^]*DATABASE_URL/);
  r = seed(e({ SEED_PASSWORD: '' }));
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/SEED_PASSWORD_MISSING/);
  // 0 users: refused runs never opened the (unmigrated) fresh DB
  expect((await import('node:fs')).existsSync(join(dir, 'fresh.db'))).toBe(false);
});
