import { expect, test } from 'vitest';
import { oneLine, renderClaimMail, SUBJECT, type ClaimMailInput } from './rules.js';

const base: ClaimMailInput = { kind: 'approved', claimId: 'c1', title: 'Taxi', totalCents: 12550, actorName: 'Mia', reason: null, paymentDate: null, paymentReference: null, publicBaseUrl: 'http://app.test' };

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
