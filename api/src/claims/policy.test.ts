import { expect, test } from 'vitest';
import { checkSubmit, SubmitRefused, utcToday, type PolicyLine } from './policy.js';

const limits = new Map([['meals', 5000], ['accommodation', 20000]]);
const T = '2026-06-30';
const line = (o: Partial<PolicyLine> = {}): PolicyLine => ({ id: 'l1', position: 1, date: T, categoryCode: 'meals', amountCents: 1000, justification: null, receiptCount: 0, ...o });
const run = (l: Partial<PolicyLine>, c = {}) => checkSubmit({ title: 'T', purpose: 'long enough purpose', lines: [line(l)], ...c }, limits, T).map((f) => f.code);

test('clean claim has no failures; utcToday uses the UTC date', () => {
  expect(run({})).toEqual([]);
  expect(utcToday(new Date('2026-06-30T23:59:59Z'))).toBe(T);
});
test('date window: today and today-90d pass; +1 and -91d fail', () => {
  expect(run({ date: T })).toEqual([]);
  expect(run({ date: '2026-04-01' })).toEqual([]); // 90 days before 2026-06-30
  expect(run({ date: '2026-07-01' })).toEqual(['date_in_future']);
  expect(run({ date: '2026-03-31' })).toEqual(['date_too_old']);
});
test('amount range: 0 and 1000001 fail, 1 and 1000000 pass', () => {
  expect(run({ amountCents: 0 })).toEqual(['amount_out_of_range']);
  expect(run({ amountCents: 1_000_001, receiptCount: 1, justification: 'x'.repeat(20) })).toEqual(['amount_out_of_range']);
  expect(run({ amountCents: 1 })).toEqual([]);
  expect(run({ amountCents: 1_000_000, receiptCount: 1, justification: 'x'.repeat(20), categoryCode: 'accommodation' })).toEqual([]);
});
test('receipt required from 2500 cents', () => {
  expect(run({ amountCents: 2499 })).toEqual([]);
  expect(run({ amountCents: 2500 })).toEqual(['receipt_required']);
  expect(run({ amountCents: 2500, receiptCount: 1 })).toEqual([]);
});
test('justification: over limit needs 20 trimmed chars; at limit needs none', () => {
  const o = { amountCents: 5001, receiptCount: 1 };
  expect(run({ ...o, justification: null })).toEqual(['justification_required']);
  expect(run({ ...o, justification: ' '.repeat(30) })).toEqual(['justification_required']);
  expect(run({ ...o, justification: 'x'.repeat(19) })).toEqual(['justification_required']);
  expect(run({ ...o, justification: 'x'.repeat(20) })).toEqual([]);
  expect(run({ amountCents: 5000, receiptCount: 1 })).toEqual([]);
  expect(run({ amountCents: 20001, categoryCode: 'accommodation', receiptCount: 1 })).toEqual(['justification_required']);
});
test('claim-level rules, no_lines, and ordering (claim first, then position, then rule order)', () => {
  expect(checkSubmit({ title: ' ', purpose: 'short', lines: [] }, limits, T).map((f) => f.code)).toEqual(['title_invalid', 'purpose_too_short', 'no_lines']);
  const f = checkSubmit({ title: 'T', purpose: 'short', lines: [line({ id: 'b', position: 2, date: '2026-07-01' }), line({ id: 'a', position: 1, amountCents: 3000 })] }, limits, T);
  expect(f.map((x) => [x.code, x.position])).toEqual([['purpose_too_short', undefined], ['receipt_required', 1], ['date_in_future', 2]]);
});
test('SubmitRefused carries the 422 contract with a count reason', () => {
  const e = new SubmitRefused([{ code: 'no_lines', message: 'm' }], 'draft');
  expect([e.status, e.code, e.reason, e.extra]).toEqual([422, 'validation_failed', '1 problems', { failures: e.failures }]);
});
