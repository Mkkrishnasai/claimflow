import { expect, test } from 'vitest';
import { expired, nextState, oneLine, retryDelay, renderClaimMail, SUBJECT, type ClaimMailInput } from './rules.js';

const base: ClaimMailInput = { kind: 'approved', claimId: 'c1', title: 'Taxi', totalCents: 12550, actorName: 'Mia', reason: null, paymentDate: null, paymentReference: null, publicBaseUrl: 'http://app.test' };

const T = new Date(0), at = (min: number) => new Date(min * 60_000);
test('retryDelay is min(60000 * 2^(n-1), 900000) for n = 1..6', () => {
  expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([60000, 120000, 240000, 480000, 900000, 900000]);
});

test('nextState returns sent, pending or failed; deadline is createdAt + 2 h inclusive', () => {
  expect(nextState(true, 0, T, at(0))).toEqual({ status: 'sent' });
  expect(nextState(false, 0, T, at(0))).toEqual({ status: 'pending', attempts: 1, nextAttemptAt: at(1) });
  expect(nextState(false, 11, T, at(105))).toEqual({ status: 'pending', attempts: 12, nextAttemptAt: at(120) });
  expect(nextState(false, 11, T, at(120))).toEqual({ status: 'failed', attempts: 12 });
  expect([expired(T, at(120)), expired(T, at(121))]).toEqual([false, true]);
});

test('oneLine strips CR and LF', () => expect(oneLine('x\r\nBcc: a@b.test\n')).toBe('x Bcc: a@b.test '));

test('approved body has title, EUR total, actor and link; subjects are fixed', () => {
  const m = renderClaimMail(base);
  expect(m.subject).toBe('Your claim was approved');
  for (const s of ['Taxi', 'EUR 125.50', 'Mia', 'http://app.test/claims/c1']) expect(m.text).toContain(s);
  expect(Object.values(SUBJECT)).toEqual(['Your claim was approved', 'Your claim was rejected', 'Your claim was sent back', 'Your claim was paid']);
});

test('rejected / sent back carry the reason verbatim; paid carries date and reference', () => {
  expect(renderClaimMail({ ...base, kind: 'rejected', reason: 'too vague, resubmit' }).text).toContain('too vague, resubmit');
  expect(renderClaimMail({ ...base, kind: 'sent_back', reason: 'needs receipt' }).subject).toBe('Your claim was sent back');
  const p = renderClaimMail({ ...base, kind: 'paid', paymentDate: '2026-01-15', paymentReference: 'INV-1' });
  expect(p.text).toContain('2026-01-15'); expect(p.text).toContain('INV-1');
});

test('injected title stays on one line', () => {
  const t = renderClaimMail({ ...base, title: 'x\r\nBcc: a@b.test' }).text;
  expect(t).toContain('Claim: x Bcc: a@b.test\n');
  expect(t).not.toMatch(/\r|\n(Bcc)/);
});
