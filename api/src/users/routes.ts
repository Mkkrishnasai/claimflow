import { Router } from 'express';
import { HttpError } from '../middleware.js';
import { createUser, type UserDeps } from './service.js';

const adminOnly = (req: Express.Request) => {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'forbidden');
};

export function userRoutes(d: UserDeps): Router {
  const r = Router();
  // E-12
  r.post('/users', async (req, res) => {
    adminOnly(req);
    const u = await createUser(d, req.body ?? {});
    res.status(201).location(`/api/users/${u.id}`).json(u);
  });
  return r;
}
