import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canReadClaim, canReadUser, requireAdmin } from '../../api/src/auth/authz.js';

// chain: c0 -> d1 -> d2 -> d3 (claimant c0 reports to d1, ...). mgrOf stub, no DB.
const up: Record<string, string> = { c0: 'd1', d1: 'd2', d2: 'd3', u: 'top', ob: 'obm' };
const mgrOf = (id: string) => up[id] ?? null;
const ROLES = ['employee', 'manager', 'finance', 'admin'];

test('canReadClaim: AC-10 table, every role x relationship', () => {
  const cell = (role: string, requesterId: string, claimantId: string, status = 'submitted') =>
    canReadClaim({ id: requesterId, role }, { claimantId, status }, mgrOf);
  for (const r of ROLES) assert.equal(cell(r, 'c0', 'c0', 'draft'), true, `${r} own draft`);
  assert.equal(cell('employee', 'd1', 'c0'), false);
  assert.equal(cell('admin', 'd1', 'c0'), false);
  assert.equal(cell('manager', 'd1', 'c0'), true); // depth 1
  assert.equal(cell('manager', 'd2', 'c0'), true); // depth 2
  assert.equal(cell('manager', 'd3', 'c0'), false); // depth 3
  assert.equal(cell('manager', 'c0', 'd1'), false); // upward
  assert.equal(cell('manager', 'obm', 'c0'), false); // other branch
  assert.equal(cell('manager', 'zzz', 'c0'), false); // unrelated
  assert.equal(cell('finance', 'f', 'c0', 'submitted'), true);
  assert.equal(cell('finance', 'f', 'c0', 'paid'), true);
  assert.equal(cell('finance', 'f', 'c0', 'draft'), false);
});

test('canReadUser and requireAdmin', () => {
  for (const r of ROLES) {
    assert.equal(canReadUser({ id: 'x', role: r }, 'x'), true);
    assert.equal(canReadUser({ id: 'x', role: r }, 'y'), r === 'admin');
    if (r === 'admin') assert.doesNotThrow(() => requireAdmin({ id: 'x', role: r }));
    else assert.throws(() => requireAdmin({ id: 'x', role: r }), { status: 403 });
  }
  assert.throws(() => requireAdmin(undefined), { status: 403 });
});

test('role comparisons live only in authz.ts', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
  const offenders = walk('api/src').filter((f) => !f.endsWith('authz.ts') && /role ===|\.role !==/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
