import { expect, test } from 'vitest';
import { expired, nextState, oneLine, retryDelay, renderClaimMail, SUBJECT, digestDue, digestKey, renderDigest, type ClaimMailInput } from './rules.js';

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

test('digestDue is true from 08:00 UTC; digestKey uses the UTC date', () => {
  expect([digestDue(new Date('2026-01-01T07:59:59Z')), digestDue(new Date('2026-01-01T08:00:00Z'))]).toEqual([false, true]);
  expect(digestKey('u1', new Date('2026-01-01T23:30:00Z'))).toBe('digest:u1:2026-01-01');
});

test('renderDigest lists claims and the approvals link; 101 gives 100 lines and "and 1 more"', () => {
  const item = (i: number) => ({ claimant: `Ann${i}`, title: 'Taxi\r\nBcc: x', totalCents: 12550, submittedAt: new Date('2026-01-02T10:00:00Z') });
  const three = renderDigest([1, 2, 3].map(item), 3, 'http://app.test');
  expect(three.subject).toBe('Claims waiting for your approval');
  expect(three.text.split('\n').filter((l) => l.includes('EUR 125.50 | 2026-01-02'))).toHaveLength(3);
  expect(three.text).toContain('Ann1 | Taxi Bcc: x');
  expect(three.text).toContain('http://app.test/approvals');
  const many = renderDigest(Array.from({ length: 100 }, (_, i) => item(i)), 101, 'http://app.test');
  expect(many.text.split('\n').filter((l) => l.includes('EUR 125.50'))).toHaveLength(100);
  expect(many.text).toContain('and 1 more');
});
