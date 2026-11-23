import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const tmp = mkdtempSync(join(tmpdir(), 'mig-'));
const env = { ...process.env, DATABASE_URL: `file:${join(tmp, 'm.db')}` } as NodeJS.ProcessEnv;
const prisma = (args: string[], input?: string) =>
  spawnSync(join(root, 'node_modules/.bin/prisma'), args, { cwd: tmp, env, encoding: 'utf8', input });

test('accounts migration upgrades 5 seeded users without loss', () => {
  cpSync(join(root, 'prisma'), join(tmp, 'prisma'), { recursive: true });
  const migs = readdirSync(join(tmp, 'prisma/migrations')).filter((d) => d.endsWith('_accounts'));
  assert.equal(migs.length, 1);
  const hold = join(tmp, 'held');
  mkdirSync(hold);
  cpSync(join(tmp, 'prisma/migrations', migs[0]), join(hold, migs[0]), { recursive: true });
  rmSync(join(tmp, 'prisma/migrations', migs[0]), { recursive: true });

  assert.equal(prisma(['migrate', 'deploy']).status, 0);
  const emails = ['senior.manager', 'manager', 'employee', 'finance', 'admin'];
  const sql = emails.map((e, i) => `INSERT INTO "User" (id,email,passwordHash,role) VALUES ('u${i}','${e}@claimflow.test','$2b$12$hash${i}','employee');`).join('\n');
  const ins = prisma(['db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'], sql);
  assert.equal(ins.status, 0, ins.stderr);

  cpSync(join(hold, migs[0]), join(tmp, 'prisma/migrations', migs[0]), { recursive: true });
  const dep = prisma(['migrate', 'deploy']);
  assert.equal(dep.status, 0, dep.stderr);

  const sel = spawnSync('sqlite3', ['-json', join(tmp, 'm.db'),
    'SELECT email,name,active,passwordHash FROM "User" ORDER BY id; SELECT name FROM sqlite_master WHERE name IN (\'OneTimeToken\',\'Session\',\'LoginAttempt\') ORDER BY name;'], { encoding: 'utf8' });
  assert.equal(sel.status, 0, sel.stderr);
  const [rows, tables] = sel.stdout.split(/\n(?=\[)/).map((j) => JSON.parse(j));
  assert.equal(rows.length, 5);
  rows.forEach((r: Record<string, unknown>, i: number) => {
    assert.equal(r.name, emails[i]);
    assert.equal(r.active, 1);
    assert.equal(r.passwordHash, `$2b$12$hash${i}`);
  });
  assert.equal(tables.length, 3);
  rmSync(tmp, { recursive: true, force: true });
});
