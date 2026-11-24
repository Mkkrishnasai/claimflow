// C-36 (FR-5): pure CSV builder for paid claims. Money by string only (NFR-DATA-1).
import { cycleStart } from './payment.js';

export interface ExportLine { claimId: string; employee: string; category: string; amountCents: number; paymentDate: string; paymentReference: string }
export interface ExportEvent { claimId: string; action: string; actorName: string }

export const HEADER = 'claim_id,employee,approvers,category,line_amount_eur,claim_total_eur,payment_date,payment_reference';
const APPROVALS = new Set(['approve_first', 'approve_final', 'approve_second']);

// Callers pass a non-negative safe integer.
export const euro = (c: number): string => {
  const s = String(c).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};

// Formula-injection guard, then RFC 4180 quoting.
export function cell(s: string): string {
  const v = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[,"\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

// `ev` is in seq order; only the last submit/resubmit cycle counts.
export const approversOf = (ev: { action: string; actorName: string }[]): string[] =>
  ev.slice(cycleStart(ev.map((e) => e.action))).filter((e) => APPROVALS.has(e.action)).map((e) => e.actorName);

export function paidClaimsCsv(lines: ExportLine[], events: ExportEvent[]): { csv: string; rows: number } {
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.claimId, (totals.get(l.claimId) ?? 0) + l.amountCents);
  const byClaim = new Map<string, ExportEvent[]>();
  for (const e of events) byClaim.set(e.claimId, [...(byClaim.get(e.claimId) ?? []), e]);
  const rows = lines.map((l) =>
    [l.claimId, cell(l.employee), cell(approversOf(byClaim.get(l.claimId) ?? []).join('; ')), cell(l.category), euro(l.amountCents), euro(totals.get(l.claimId)!), l.paymentDate, cell(l.paymentReference)].join(','));
  return { csv: [HEADER, ...rows].map((r) => `${r}\r\n`).join(''), rows: lines.length };
}
