import { Router } from 'express';
import { mount, requireFinance, type RouteDef } from '../auth/authz.js';
import { HttpError } from '../middleware.js';
import type { ClaimDeps } from '../claims/service.js';
import { readPolicy } from './service.js';

export const policyRouteDefs = (d: ClaimDeps): RouteDef[] => [
  // finance only; role checked from the session before any read
  { method: 'get', path: '/policy', data: 'policy', write: false, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    requireFinance(req.user);
    res.json(await readPolicy(d));
  } },
];

export const policyRoutes = (d: ClaimDeps): Router => mount(Router(), policyRouteDefs(d));
