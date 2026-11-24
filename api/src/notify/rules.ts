import { euro } from '../claims/export.js';

// C-39. Fixed subjects only (NFR-SEC-1); never built from user input.
export const SUBJECT = { approved: 'Your claim was approved', rejected: 'Your claim was rejected', sent_back: 'Your claim was sent back', paid: 'Your claim was paid' } as const;
export type ClaimMailKind = keyof typeof SUBJECT;
export const BATCH = 50;

// Strip CR/LF so user text cannot start a new header or body line.
export const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

export interface ClaimMailInput { kind: ClaimMailKind; claimId: string; title: string; totalCents: number; actorName: string; reason: string | null; paymentDate: string | null; paymentReference: string | null; publicBaseUrl: string }

export function renderClaimMail(i: ClaimMailInput): { subject: string; text: string } {
  const lines = [`Claim: ${oneLine(i.title)}`, `Total: EUR ${euro(i.totalCents)}`, `By: ${oneLine(i.actorName)}`];
  if ((i.kind === 'rejected' || i.kind === 'sent_back') && i.reason) lines.push(`Reason: ${oneLine(i.reason)}`);
  if (i.kind === 'paid') lines.push(`Payment date: ${oneLine(i.paymentDate ?? '')}`, `Payment reference: ${oneLine(i.paymentReference ?? '')}`);
  lines.push(`${i.publicBaseUrl}/claims/${i.claimId}`);
  return { subject: SUBJECT[i.kind], text: lines.join('\n') + '\n' };
}
