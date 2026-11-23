import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTestRouteDefs } from '../../api/src/test-routes.js';
import { claimRouteDefs, receiptUploadDefs } from '../../api/src/claims/routes.js';
import { userRouteDefs } from '../../api/src/users/routes.js';
import { PUBLIC_ROUTES } from '../../api/src/auth/session.js';
import { COVERED } from './authz-matrix.helpers.js';

const defs = () => [...userRouteDefs({} as never), ...claimTestRouteDefs({} as never), ...claimRouteDefs({} as never), ...receiptUploadDefs({} as never)];
const key = (d: { method: string; path: string }) => `${d.method.toUpperCase()} ${d.path}`;

// Every RouteDef returning claim or user data must appear in the matrix fixture list (NFR-MAINT-1).
test('matrix covers every RouteDef with data !== none', () => {
  const missing = defs().filter((d) => d.data !== 'none' && !COVERED.includes(key(d))).map(key);
  assert.deepEqual(missing, []);
});

test('COVERED names all 16 claim data routes and nothing stale; PUBLIC_ROUTES unchanged', () => {
  const claim = [...claimRouteDefs({} as never), ...receiptUploadDefs({} as never)].filter((d) => d.data === 'claim').map(key);
  assert.equal(claim.length, 16);
  assert.deepEqual(claim.filter((k) => !COVERED.includes(k)), []);
  assert.deepEqual(COVERED.filter((k) => !defs().some((d) => key(d) === k)), []);
  assert.deepEqual([...PUBLIC_ROUTES].sort(), ['GET /auth/csrf', 'POST /auth/forgot-password', 'POST /auth/set-password', 'POST /auth/sign-in']);
});
