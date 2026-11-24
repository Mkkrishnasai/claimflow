// PR guards vs a base ref: protected paths untouched (FR-15 AC-3), assertion counts not reduced (FR-15 AC-2).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED = /^(api|prisma)\//; // also covers api/src/notify/**
const TEST_FILE = /(^tests\/|\.test\.[cm]?[jt]sx?$)/;
const count = (s) => (s.match(/\bexpect\(|\bassert\./g) ?? []).length;

export function guard(base, cwd = '.') {
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
  const changed = git('diff', '--name-only', base).split('\n').filter(Boolean);
  const protectedHits = changed.filter((f) => PROTECTED.test(f));
  const tests = changed.filter((f) => TEST_FILE.test(f)).map((f) => {
    let before = 0;
    try { before = count(git('show', `${base}:${f}`)); } catch { /* new file */ }
    const after = existsSync(join(cwd, f)) ? count(readFileSync(join(cwd, f), 'utf8')) : 0;
    return { file: f, before, after };
  });
  return { protectedHits, tests, ok: !protectedHits.length && tests.every((t) => t.after >= t.before) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) { console.error('usage: node scripts/pr-guard.mjs <base-ref>'); process.exit(2); }
  const r = guard(base);
  for (const p of r.protectedHits) console.error(`PROTECTED path changed: ${p}`);
  console.log(`protected paths changed: ${r.protectedHits.length}`);
  for (const t of r.tests) console.log(`${t.after < t.before ? 'DROP' : 'ok  '} ${t.file}: before ${t.before}, after ${t.after}`);
  process.exit(r.ok ? 0 : 1);
}
