import type { Request, RequestHandler, Router } from 'express';
import { HttpError } from '../middleware.js';

// The only file in api/src allowed to compare roles (S8 AC-5). Pure: no DB, Express or session.
export interface Requester { id: string; role: string }
export interface ClaimRef { claimantId: string; status: string; approverId?: string | null }
export type MgrOf = (userId: string) => string | null;

// FR-8 / AC-10 table. Manager depth counts hops up the chain from claimant to requester (1 or 2 only).
export function canReadClaim(u: Requester, c: ClaimRef, mgrOf: MgrOf): boolean {
  if (u.id === c.claimantId) return true;
  if (c.approverId != null && c.approverId === u.id) return true; // current approver, any depth (ADR-18)
  if (u.role === 'finance') return c.status !== 'draft'; // Q-4
  if (u.role !== 'manager') return false;
  const d1 = mgrOf(c.claimantId);
  return d1 === u.id || (d1 !== null && mgrOf(d1) === u.id);
}

export const canReadUser = (u: Requester, targetId: string): boolean => u.role === 'admin' || u.id === targetId;

export function requireAdmin(u: Requester | undefined): void {
  if (u?.role !== 'admin') throw new HttpError(403, 'forbidden');
}

export function requireFinance(u: Requester | undefined): void {
  if (u?.role !== 'finance') throw new HttpError(403, 'forbidden');
}

export const isManagerRole = (role: string): boolean => role === 'manager'; // Q-13 hierarchy rule

// ADR-19: declarative route tables, so tests can enumerate every route and its data class.
export interface RouteDef {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  data: 'none' | 'claim' | 'user' | 'policy';
  write: boolean;
  handler: RequestHandler;
}
export function mount(r: Router, defs: RouteDef[]): Router {
  for (const d of defs) r[d.method](d.path, d.handler);
  return r;
}
export type { Request };
