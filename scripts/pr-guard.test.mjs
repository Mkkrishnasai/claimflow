import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guard } from './pr-guard.mjs';
import { bundleKb, BUDGET_KB } from './bundle-size.mjs';

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'x');
  w('tests/a.test.ts', 'expect(1);expect(2);'); w('api/x.ts', '1');
  g('add', '-A'); g('commit', '-qm', 'base');
  return { d, w };
}

test('clean change passes; protected path and assertion drop fail', () => {
  const { d, w } = repo();
  w('web/a.ts', 'x'); w('tests/a.test.ts', 'expect(1);expect(2);expect(3);');
  expect(guard('HEAD', d).ok).toBe(true);
  w('api/x.ts', '2');
  expect(guard('HEAD', d).protectedHits).toEqual(['api/x.ts']);
  w('api/x.ts', '1'); w('tests/a.test.ts', 'expect(1);');
  const r = guard('HEAD', d);
  expect(r.tests).toEqual([{ file: 'tests/a.test.ts', before: 2, after: 1 }]);
  expect(r.ok).toBe(false);
});

test('bundleKb gzips js/css only', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  fs.writeFileSync(path.join(d, 'a.js'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(d, 'f.woff2'), 'y'.repeat(5000));
  const kb = bundleKb(d);
  expect(kb).toBeGreaterThan(0);
  expect(kb).toBeLessThan(BUDGET_KB);
});
