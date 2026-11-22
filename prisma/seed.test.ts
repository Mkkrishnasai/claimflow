import { test, before } from 'node:test';
import assert from 'node:assert/strict';
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

before(() => assert.equal(migrate().status, 0));

test('AC-1 migrate deploy is idempotent', () => {
  const r = migrate();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No pending migrations/);
});

test('AC-2/4 seed creates exact hierarchy with cost-10 hashes', async () => {
  assert.equal(seed(baseEnv).status, 0);
  const p = db();
  const users = await p.user.findMany();
  const by = Object.fromEntries(users.map((u) => [u.email, u]));
  assert.equal(users.length, 5);
  const sm = by['senior.manager@claimflow.test'], m = by['manager@claimflow.test'];
  assert.equal(sm.managerId, null);
  assert.equal(m.role, 'manager'); assert.equal(m.managerId, sm.id);
  assert.equal(by['employee@claimflow.test'].role, 'employee');
  assert.equal(by['employee@claimflow.test'].managerId, m.id);
  assert.equal(by['finance@claimflow.test'].role, 'finance');
  assert.equal(by['admin@claimflow.test'].role, 'admin');
  assert.equal(by['finance@claimflow.test'].managerId, sm.id);
  assert.equal(by['admin@claimflow.test'].managerId, sm.id);
  for (const u of users) {
    assert.match(u.passwordHash, /^\$2[aby]\$10\$/);
    assert.ok(await bcrypt.compare(PW, u.passwordHash));
  }
  for (const f of ['seed.ts', 'seed-guards.ts']) assert.ok(!readFileSync(join('prisma', f), 'utf8').includes(PW));
  await p.$disconnect();
});

test('AC-3 re-seed does not overwrite', async () => {
  const p = db();
  await p.user.update({ where: { email: 'finance@claimflow.test' }, data: { role: 'admin' } });
  assert.equal(seed(baseEnv).status, 0);
  assert.equal(await p.user.count(), 5);
  assert.equal((await p.user.findUniqueOrThrow({ where: { email: 'finance@claimflow.test' } })).role, 'admin');
  await p.$disconnect();
});

test('AC-5 guards order (pure)', () => {
  const g = checkSeedGuards;
  assert.equal(g({ NODE_ENV: 'production' })?.code, 'SEED_REFUSED_PRODUCTION');
  assert.equal(g({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x' })?.code, 'SEED_REFUSED_PRODUCTION');
  assert.equal(g({ DATABASE_URL: 'postgresql://x', SEED_PASSWORD: 'p' })?.code, 'SEED_REFUSED_NON_LOCAL_DB');
  const unset = g({ SEED_PASSWORD: 'p' });
  assert.equal(unset?.code, 'SEED_REFUSED_NON_LOCAL_DB');
  assert.match(unset!.message, /DATABASE_URL/);
  assert.equal(g({ DATABASE_URL: 'file:x' })?.code, 'SEED_PASSWORD_MISSING');
  assert.equal(g({ DATABASE_URL: 'file:x', SEED_PASSWORD: '' })?.code, 'SEED_PASSWORD_MISSING');
  assert.equal(g({ DATABASE_URL: 'file:x', SEED_PASSWORD: 'p' }), null);
});

test('AC-5 seed process refuses and creates 0 users', async () => {
  const fresh = `file:${join(dir, 'fresh.db')}`;
  const e = (o: Record<string, string | undefined>) => {
    const env = { ...baseEnv, DATABASE_URL: fresh, ...o } as NodeJS.ProcessEnv;
    for (const k of Object.keys(o)) if (o[k] === undefined) delete env[k];
    return env;
  };
  let r = seed(e({ NODE_ENV: 'production', SEED_PASSWORD: undefined }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SEED_REFUSED_PRODUCTION/);
  assert.doesNotMatch(r.stderr, /SEED_PASSWORD_MISSING/);
  r = seed(e({ DATABASE_URL: 'postgresql://x' }));
  assert.match(r.stderr, /SEED_REFUSED_NON_LOCAL_DB/);
  r = seed(e({ DATABASE_URL: undefined }));
  assert.match(r.stderr, /SEED_REFUSED_NON_LOCAL_DB[^]*DATABASE_URL/);
  r = seed(e({ SEED_PASSWORD: '' }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SEED_PASSWORD_MISSING/);
  // 0 users: refused runs never opened the (unmigrated) fresh DB
  assert.equal((await import('node:fs')).existsSync(join(dir, 'fresh.db')), false);
});
