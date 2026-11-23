import { HttpError } from '../middleware.js';

// C-31. Pure approval rules: no DB, no Express. Money is integer cents (spec Assumption 1: strict >).
export const SECOND_APPROVAL_CENTS = 200_000;

export type Decision = { action: 'approve_first'; approverId: string } | { action: 'approve_final' } | { action: 'approve_second' };

export function decideApproval(status: string, totalCents: number, secondApproverId: string | null): Decision | null {
  if (status === 'submitted') return totalCents > SECOND_APPROVAL_CENTS && secondApproverId !== null ? { action: 'approve_first', approverId: secondApproverId } : { action: 'approve_final' };
  return status === 'approved' ? { action: 'approve_second' } : null;
}

export const rejectAction = (status: string): 'reject' | 'reject_second' | null => (status === 'submitted' ? 'reject' : status === 'approved' ? 'reject_second' : null);

const stateError = (status: string) => new HttpError(409, status === 'paid' ? 'claim_paid' : 'invalid_transition');

// ADR-31 as refined by ADR-37: self-approval, then current approver, then race losers (409), then outsiders (403).
export function checkActor(c: { claimantId: string; approverId: string | null; status: string }, me: string, stake: { readable: boolean; firstApproverId: string | null }): HttpError | null {
  if (c.claimantId === me) return new HttpError(403, 'self_approval');
  const pending = c.status === 'submitted' || c.status === 'approved';
  if (c.approverId === me) return pending ? null : stateError(c.status);
  if ((stake.readable || stake.firstApproverId === me) && (!pending || (c.status === 'approved' && stake.firstApproverId === me))) return stateError(c.status);
  return new HttpError(403, 'forbidden');
}
