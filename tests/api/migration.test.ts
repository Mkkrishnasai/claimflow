import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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

test('payment migration: columns, index, 11 triggers, additive SQL', () => {
  const dir = readdirSync(join(root, 'prisma/migrations')).find((d) => d.endsWith('_payment'))!;
  assert.doesNotMatch(readFileSync(join(root, 'prisma/migrations', dir, 'migration.sql'), 'utf8'), /RedefineTables|DROP TABLE "Claim"/);
  const db = join(mkdtempSync(join(tmpdir(), 'mig2-')), 'p.db');
  const e = { ...env, DATABASE_URL: `file:${db}` };
  assert.equal(spawnSync(join(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], { cwd: root, env: e, encoding: 'utf8' }).status, 0);
  const q = (s: string) => spawnSync('sqlite3', ['-json', db, s], { encoding: 'utf8' }).stdout;
  const cols = JSON.parse(q(`SELECT name FROM pragma_table_info('Claim')`)).map((r: { name: string }) => r.name);
  assert.ok(cols.includes('paymentDate') && cols.includes('paymentReference'));
  assert.equal(JSON.parse(q(`SELECT name FROM sqlite_master WHERE name = 'Claim_status_updatedAt_idx'`)).length, 1);
  const trg = JSON.parse(q(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).map((r: { name: string }) => r.name);
  assert.equal(trg.length, 11);
  assert.ok(trg.includes('claim_paid_needs_payment'));
});
