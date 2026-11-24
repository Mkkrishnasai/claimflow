import { expect, test } from 'vitest';
import { approvalsComplete } from './payment.js';

test('AC-1 final, or first then second, is complete; nothing, submit or first only is not', () => {
  expect(approvalsComplete(['submit', 'approve_final'])).toBe(true);
  expect(approvalsComplete(['submit', 'approve_first', 'approve_second'])).toBe(true);
  for (const a of [['submit'], ['submit', 'approve_first'], []]) expect(approvalsComplete(a)).toBe(false);
});

test('AC-2 approvals before a send-back or rejection do not count after resubmit', () => {
  expect(approvalsComplete(['submit', 'approve_final', 'send_back', 'resubmit'])).toBe(false);
  expect(approvalsComplete(['submit', 'approve_final', 'send_back', 'resubmit', 'approve_final'])).toBe(true);
  expect(approvalsComplete(['submit', 'approve_first', 'reject_second', 'resubmit', 'approve_first'])).toBe(false);
});
