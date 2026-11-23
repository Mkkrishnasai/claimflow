import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTestRouteDefs } from '../../api/src/test-routes.js';
import { claimRouteDefs } from '../../api/src/claims/routes.js';
import { userRouteDefs } from '../../api/src/users/routes.js';
import { COVERED } from './authz-matrix.helpers.js';

// Every RouteDef returning claim or user data must appear in the matrix fixture list (NFR-MAINT-1).
test('matrix covers every RouteDef with data !== none', () => {
  const defs = [...userRouteDefs({} as never), ...claimTestRouteDefs({} as never), ...claimRouteDefs({} as never)];
  const missing = defs.filter((d) => d.data !== 'none' && !COVERED.includes(`${d.method.toUpperCase()} ${d.path}`)).map((d) => `${d.method} ${d.path}`);
  assert.deepEqual(missing, []);
});
