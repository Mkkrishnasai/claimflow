import express, { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { canReadClaim, mount, type RouteDef } from './auth/authz.js';
import { authenticate } from './auth/session.js';
import { FixtureClaimStore, type ClaimStatus } from './claims-port.js';
import type { Clock } from './db.js';
import { HttpError } from './middleware.js';

export const testRouter: Router = Router();

testRouter.post('/__test/echo', express.json({ limit: '100kb' }), (_req, res) => {
  res.status(200).json({ ok: true });
});

testRouter.get('/__test/error', (req, res, next) => {
  const q = (k: string) => String(req.query[k] ?? '');
  const ctx = { password: q('password'), receipt: q('receipt'), bankAccount: q('bankAccount') };
  const err = new Error(`test error ${ctx.password} ${ctx.receipt} ${ctx.bankAccount}`, {
    cause: new Error(`cause ${ctx.password} ${ctx.receipt} ${ctx.bankAccount}`),
  });
  Object.assign(err, { context: ctx });
  next(err);
});

export const claimStore = new FixtureClaimStore();
const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paid'];

// E-16..E-18, mounted only under NODE_ENV=test. Authenticated like /api routes.
export const claimTestRouteDefs = (prisma: PrismaClient): RouteDef[] => [
  { method: 'post', path: '/__test/fixtures/claims', data: 'claim', write: true, handler: async (req, res) => {
    const { id, claimantId, approverId = null, status = 'submitted' } = req.body ?? {};
    if (typeof claimantId !== 'string' || !STATUSES.includes(status)) throw new HttpError(400, 'invalid_input');
    res.status(201).json(claimStore.add({ id, claimantId, approverId, status: status as ClaimStatus }));
  } },
  { method: 'post', path: '/__test/fixtures/reset', data: 'none', write: true, handler: (_req, res) => {
    claimStore.reset();
    res.status(204).end();
  } },
  { method: 'get', path: '/__test/claims/:id', data: 'claim', write: false, handler: async (req, res) => {
    const c = await claimStore.get(prisma as never, req.params.id as string);
    if (!c) throw new HttpError(404, 'not_found'); // Q-5: any authenticated caller
    // load the claimant's two nearest managers; that is all depth 1-2 needs
    const chain = new Map<string, string | null>();
    let cur: string | null = c.claimantId;
    for (let i = 0; i < 2 && cur; i++) {
      const row: { managerId: string | null } | null = await prisma.user.findUnique({ where: { id: cur }, select: { managerId: true } });
      chain.set(cur, row?.managerId ?? null);
      cur = row?.managerId ?? null;
    }
    if (!req.user || !canReadClaim(req.user, c, (id) => chain.get(id) ?? null)) throw new HttpError(403, 'forbidden');
    res.json(c);
  } },
];

export function claimTestRoutes(prisma: PrismaClient, clock: Clock): Router {
  const r = Router();
  r.use('/__test', authenticate(prisma, clock), express.json({ limit: '10kb' }));
  return mount(r, claimTestRouteDefs(prisma));
}
