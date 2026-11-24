// Matrix fixture list: every claim / user-data route the matrix test exercises.
export const COVERED = [
  'GET /policy', 'PATCH /policy', 'GET /users', 'GET /users/:id', 'POST /users', 'PATCH /users/:id/manager', 'POST /users/:id/resend-link', 'POST /users/:id/deactivate',
  'POST /__test/fixtures/claims', 'GET /__test/claims/:id',
  'GET /claims', 'GET /approvals', 'GET /payments', 'GET /exports/paid-claims.csv', 'POST /claims', 'GET /claims/:id',
  'PATCH /claims/:id', 'DELETE /claims/:id', 'POST /claims/:id/lines', 'PATCH /claims/:id/lines/:lineId', 'DELETE /claims/:id/lines/:lineId', 'POST /claims/:id/lines/:lineId/receipts', 'GET /claims/:id/receipts/:receiptId', 'DELETE /claims/:id/receipts/:receiptId', 'POST /claims/:id/submit', 'POST /claims/:id/withdraw', 'POST /claims/:id/approve', 'POST /claims/:id/reject', 'POST /claims/:id/pay', 'POST /claims/:id/send-back',
];

export const ROLES = ['employee', 'manager', 'finance', 'admin'] as const;
export const ROLE_USER = { employee: 'emp', manager: 'mgr', finance: 'fin', admin: 'adm' } as const;
export const ALL_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'ready_to_pay', 'paid'];
// Requesters: mgr is the manager of d1 and of m1; d1 -> mgr (depth 1), d2 -> m1 -> mgr (2), d3 -> m2 -> m1 -> mgr (3), mgr -> U (upward), ob -> OB (other branch), un (unrelated).
export const POS: Record<string, string> = { own: 'mgr', d1: 'd1', d2: 'd2', d3: 'd3', upward: 'U', other: 'ob', unrelated: 'un' };

// Literal read table (FR-8): the expected status for a claim read, shared by the claim and receipt read matrices.
export function canRead(role: string, pos: string, status: string): 200 | 403 {
  if (pos === 'own') return 200;
  if (role === 'manager') return pos === 'd1' || pos === 'd2' ? 200 : 403;
  if (role === 'finance') return status !== 'draft' ? 200 : 403;
  return 403;
}

// Per route key: who may act and the statuses (literal, ADR-25) in which an allowed actor succeeds. Expected codes never come from product code.
export type Actor = 'any' | 'claimant' | 'approver' | 'finance' | 'readable';
export const CLAIM_RULES: Record<string, { actor: Actor; okStatuses: string[] }> = {
  'GET /claims': { actor: 'any', okStatuses: ALL_STATUSES },
  'GET /approvals': { actor: 'any', okStatuses: ALL_STATUSES },
  'GET /payments': { actor: 'finance', okStatuses: ALL_STATUSES },
  'GET /exports/paid-claims.csv': { actor: 'finance', okStatuses: ALL_STATUSES },
  'POST /claims': { actor: 'any', okStatuses: [] },
  'GET /claims/:id': { actor: 'readable', okStatuses: ALL_STATUSES },
  'GET /claims/:id/receipts/:receiptId': { actor: 'readable', okStatuses: ALL_STATUSES },
  'PATCH /claims/:id': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'DELETE /claims/:id': { actor: 'claimant', okStatuses: ['draft'] },
  'POST /claims/:id/lines': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'PATCH /claims/:id/lines/:lineId': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'DELETE /claims/:id/lines/:lineId': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'POST /claims/:id/lines/:lineId/receipts': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'DELETE /claims/:id/receipts/:receiptId': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'POST /claims/:id/submit': { actor: 'claimant', okStatuses: ['draft', 'rejected'] },
  'POST /claims/:id/withdraw': { actor: 'claimant', okStatuses: ['submitted'] },
  'POST /claims/:id/approve': { actor: 'approver', okStatuses: ['submitted', 'approved'] },
  'POST /claims/:id/reject': { actor: 'approver', okStatuses: ['submitted', 'approved'] },
  'POST /claims/:id/pay': { actor: 'finance', okStatuses: ['ready_to_pay'] },
  'POST /claims/:id/send-back': { actor: 'finance', okStatuses: ['ready_to_pay'] },
};
export const CLAIM_KEYS = Object.keys(CLAIM_RULES).sort();
