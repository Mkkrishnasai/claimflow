import { Router } from 'express';
import { mount, type RouteDef } from '../auth/authz.js';
import { HttpError } from '../middleware.js';
import { addLine, createClaim, deleteClaim, deleteLine, editClaim, editLine, getClaim, listCategories, listMine, type ClaimDeps } from './service.js';

export const claimRouteDefs = (d: ClaimDeps): RouteDef[] => [
  // E-19
  { method: 'get', path: '/categories', data: 'none', write: false, handler: async (_req, res) => {
    res.json(await listCategories(d));
  } },
  // E-20: own claims only, whatever the caller's role
  { method: 'get', path: '/claims', data: 'claim', write: false, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    res.json(await listMine(d, req.user.id, req.query));
  } },
  // E-21
  { method: 'post', path: '/claims', data: 'claim', write: true, handler: async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated');
    const c = await createClaim(d, req.user.id, req.body ?? {});
    res.locals.logFields = { claimEvent: 'claim_created', claimId: c.id, from: null, to: 'draft' };
    res.status(201).location(`/api/claims/${c.id}`).json(c);
  } },
  // E-22: 404 unknown, 403 not allowed (canReadClaim)
  { method: 'get', path: '/claims/:id', data: 'claim', write: false, handler: async (req, res) => {
    res.json(await getClaim(d, req.user, req.params.id as string));
  } },
  // E-23..E-27: claimant-only, authorised in the service before body validation
  { method: 'patch', path: '/claims/:id', data: 'claim', write: true, handler: async (req, res) => {
    res.json(await editClaim(d, req.user, req.params.id as string, req.body ?? {}));
  } },
  { method: 'delete', path: '/claims/:id', data: 'claim', write: true, handler: async (req, res) => {
    await deleteClaim(d, req.user, req.params.id as string);
    res.status(204).end();
  } },
  { method: 'post', path: '/claims/:id/lines', data: 'claim', write: true, handler: async (req, res) => {
    res.status(201).json(await addLine(d, req.user, req.params.id as string, req.body ?? {}));
  } },
  { method: 'patch', path: '/claims/:id/lines/:lineId', data: 'claim', write: true, handler: async (req, res) => {
    res.json(await editLine(d, req.user, req.params.id as string, req.params.lineId as string, req.body ?? {}));
  } },
  { method: 'delete', path: '/claims/:id/lines/:lineId', data: 'claim', write: true, handler: async (req, res) => {
    await deleteLine(d, req.user, req.params.id as string, req.params.lineId as string);
    res.status(204).end();
  } },
];

export const claimRoutes = (d: ClaimDeps): Router => mount(Router(), claimRouteDefs(d));
