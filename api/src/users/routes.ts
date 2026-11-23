import { Router } from 'express';
import { canReadUser, mount, requireAdmin, type RouteDef } from '../auth/authz.js';
import { HttpError } from '../middleware.js';
import { createUser, getUser, listUsers, setManager, type UserDeps } from './service.js';

export const userRouteDefs = (d: UserDeps): RouteDef[] => [
  // E-10
  { method: 'get', path: '/users', data: 'user', write: false, handler: async (req, res) => {
    requireAdmin(req.user);
    res.json(await listUsers(d));
  } },
  // E-11: role check before lookup, so a non-admin gets 403 (not 404) for any other id
  { method: 'get', path: '/users/:id', data: 'user', write: false, handler: async (req, res) => {
    if (!req.user || !canReadUser(req.user, req.params.id as string)) throw new HttpError(403, 'forbidden');
    res.json(await getUser(d, req.params.id as string));
  } },
  // E-12
  { method: 'post', path: '/users', data: 'user', write: true, handler: async (req, res) => {
    requireAdmin(req.user);
    const u = await createUser(d, req.body ?? {});
    res.status(201).location(`/api/users/${u.id}`).json(u);
  } },
  // E-13
  { method: 'patch', path: '/users/:id/manager', data: 'user', write: true, handler: async (req, res) => {
    requireAdmin(req.user);
    res.json(await setManager(d, req.params.id as string, req.body ?? {}));
  } },
];

export const userRoutes = (d: UserDeps): Router => mount(Router(), userRouteDefs(d));
