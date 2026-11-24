import { expect, test } from 'vitest';
import { checkActor, decideApproval, rejectAction } from './approval.js';

test('decideApproval at the threshold, with and without a second approver', () => {
  expect(decideApproval('submitted', 200_000, 'S')).toEqual({ action: 'approve_final' });
  expect(decideApproval('submitted', 200_001, 'S')).toEqual({ action: 'approve_first', approverId: 'S' });
  expect(decideApproval('submitted', 200_001, null)).toEqual({ action: 'approve_final' });
  expect(decideApproval('submitted', 1, null)).toEqual({ action: 'approve_final' });
  expect(decideApproval('approved', 999_999, null)).toEqual({ action: 'approve_second' });
  for (const s of ['draft', 'rejected', 'ready_to_pay', 'paid']) expect(decideApproval(s, 1, 'S')).toBeNull();
});

test('rejectAction', () => {
  expect([rejectAction('submitted'), rejectAction('approved'), rejectAction('draft')]).toEqual(['reject', 'reject_second', null]);
});

test('checkActor precedence', () => {
  const c = (status: string, approverId: string | null = 'M') => ({ claimantId: 'E', approverId, status });
  const none = { readable: false, firstApproverId: null };
  const code = (e: ReturnType<typeof checkActor>) => e && [e.status, e.message];
  expect(code(checkActor({ ...c('submitted', 'E'), claimantId: 'E' }, 'E', none))).toEqual([403, 'self_approval']);
  expect(checkActor(c('submitted'), 'M', none)).toBeNull();
  expect(checkActor(c('approved'), 'M', none)).toBeNull();
  expect(code(checkActor(c('paid'), 'M', none))).toEqual([409, 'claim_paid']);
  expect(code(checkActor(c('draft'), 'M', none))).toEqual([409, 'invalid_transition']);
  expect(code(checkActor(c('submitted'), 'X', none))).toEqual([403, 'forbidden']);
  expect(code(checkActor(c('draft', null), 'X', { readable: true, firstApproverId: null }))).toEqual([409, 'invalid_transition']); // race loser with a stake
  expect(code(checkActor(c('submitted'), 'X', { readable: true, firstApproverId: null }))).toEqual([403, 'forbidden']);
  expect(code(checkActor(c('approved', 'S'), 'M', { readable: false, firstApproverId: 'M' }))).toEqual([409, 'invalid_transition']);
});
