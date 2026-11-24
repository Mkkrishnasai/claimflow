import { HttpError } from '../middleware.js';
import { euro } from './export.js';

// C-30: pure submit rules over loaded claim data. Integer-only; messages are fixed literals (NFR-SEC-2).
export const MIN_CENTS = 1;
export const MAX_CENTS = 1_000_000;
export const WINDOW_DAYS = 90;
export const JUSTIFICATION_MIN = 20;

export type Failure = { code: string; lineId?: string; position?: number; message: string };
export type PolicyLine = { id: string; position: number; date: string; categoryCode: string; amountCents: number; justification: string | null; receiptCount: number };
export type PolicyClaim = { title: string; purpose: string; lines: PolicyLine[] };

const MSG: Record<string, string> = {
  title_invalid: 'Title must be 1-120 characters',
  purpose_too_short: 'Purpose must be at least 10 characters',
  no_lines: 'A claim needs at least one line',
  amount_out_of_range: 'Amount must be from 1 to 1000000 cents',
  date_in_future: 'Date must not be in the future',
  date_too_old: 'Date must be within the last 90 days',
  justification_required: 'A justification of at least 20 characters is required above the category limit',
};

export class SubmitRefused extends HttpError {
  constructor(public readonly failures: Failure[], public readonly from: string) {
    super(422, 'validation_failed', `${failures.length} problems`, { failures });
  }
}

export const utcToday = (now: Date): string => now.toISOString().slice(0, 10);
const daysBefore = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};

export function checkSubmit(c: PolicyClaim, limits: ReadonlyMap<string, number>, today: string, receiptFromCents: number): Failure[] {
  const out: Failure[] = [];
  const claimLevel = (code: string) => out.push({ code, message: MSG[code] });
  const t = c.title.trim().length;
  if (t < 1 || t > 120) claimLevel('title_invalid');
  if (c.purpose.trim().length < 10) claimLevel('purpose_too_short');
  if (c.lines.length === 0) claimLevel('no_lines');
  const oldest = daysBefore(today, WINDOW_DAYS);
  for (const l of [...c.lines].sort((a, b) => a.position - b.position)) {
    const add = (code: string) => out.push({ code, lineId: l.id, position: l.position, message: code === 'receipt_required' ? `A receipt is required from EUR ${euro(receiptFromCents)}` : MSG[code] });
    if (l.amountCents < MIN_CENTS || l.amountCents > MAX_CENTS) add('amount_out_of_range');
    if (l.date > today) add('date_in_future');
    if (l.date < oldest) add('date_too_old');
    if (l.amountCents >= receiptFromCents && l.receiptCount === 0) add('receipt_required');
    if (l.amountCents > (limits.get(l.categoryCode) ?? 0) && (l.justification ?? '').trim().length < JUSTIFICATION_MIN) add('justification_required');
  }
  return out;
}

// FR-4: pure pick. Receipt basis wins over triple; the earlier submittedAt wins among candidates, claim id breaks ties.
export type Hit = { claimId: string; at: number };
export type Dup = { claimId: string; basis: 'receipt' | 'match' };
const earliest = (hits: Hit[]) => hits.reduce<Hit | null>((b, h) => (!b || h.at < b.at || (h.at === b.at && h.claimId < b.claimId) ? h : b), null);
export function pickDuplicates(lines: { id: string; receiptHits: Hit[]; matchHits: Hit[] }[]): Map<string, Dup> {
  const out = new Map<string, Dup>();
  for (const l of lines) {
    const r = earliest(l.receiptHits);
    const m = r ? null : earliest(l.matchHits);
    if (r) out.set(l.id, { claimId: r.claimId, basis: 'receipt' });
    else if (m) out.set(l.id, { claimId: m.claimId, basis: 'match' });
  }
  return out;
}
