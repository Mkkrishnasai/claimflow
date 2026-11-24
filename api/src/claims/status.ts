import { HttpError } from '../middleware.js';
import type { Tx } from '../db.js';

export type Status = 'draft' | 'submitted' | 'approved' | 'rejected' | 'ready_to_pay' | 'paid';
export type Action = 'submit' | 'resubmit' | 'withdraw' | 'approve_first' | 'approve_final' | 'reject' | 'approve_second' | 'reject_second' | 'send_back' | 'pay';

// C-24, FR-6: the only ten moves. Everything else is 409 invalid_transition.
export const TRANSITIONS: Record<Action, { from: Status; to: Status }> = {
  submit: { from: 'draft', to: 'submitted' },
  resubmit: { from: 'rejected', to: 'submitted' },
  withdraw: { from: 'submitted', to: 'draft' },
  approve_first: { from: 'submitted', to: 'approved' },
  approve_final: { from: 'submitted', to: 'ready_to_pay' },
  reject: { from: 'submitted', to: 'rejected' },
  approve_second: { from: 'approved', to: 'ready_to_pay' },
  reject_second: { from: 'approved', to: 'rejected' },
  send_back: { from: 'ready_to_pay', to: 'rejected' },
  pay: { from: 'ready_to_pay', to: 'paid' },
};
export const ACTIONS = Object.keys(TRANSITIONS) as Action[];
const REASON_REQUIRED: ReadonlySet<Action> = new Set(['reject', 'reject_second', 'send_back']);
const invalid = () => new HttpError(409, 'invalid_transition');

export const nextStatus = (from: string, action: Action): Status | null => (TRANSITIONS[action].from === from ? TRANSITIONS[action].to : null);

// `set` cannot carry `status`: only moveClaim writes Claim.status.
export type MoveSet = { approverId?: string | null; submittedAt?: Date | null; updatedAt?: Date; paymentDate?: string; paymentReference?: string };
export interface Move { claimId: string; action: Action; actorId: string; reason?: string | null; now: Date; set?: MoveSet; beforeAppend?: () => void | Promise<void> }

// History row: seq = max + 1, inside the caller's transaction (writes are serialised by withWrite).
export async function appendEvent(tx: Tx, e: { claimId: string; actorId: string; action: Action | 'reassigned'; fromStatus: Status; toStatus: Status; reason?: string | null; at: Date }) {
  const max = await tx.claimEvent.aggregate({ where: { claimId: e.claimId }, _max: { seq: true } });
  const { action, ...rest } = e;
  await tx.claimEvent.create({ data: { ...rest, action: action === 'withdraw' ? 'withdrawn' : action, reason: e.reason ?? null, seq: (max._max.seq ?? 0) + 1 } });
}

// Order: 404 unknown, 409 not allowed from here, 422 reason; conditional update so 0 rows = 409.
export async function moveClaim(tx: Tx, m: Move): Promise<{ action: string; from: Status; to: Status }> {
  const c = await tx.claim.findUnique({ where: { id: m.claimId }, select: { status: true } });
  if (!c) throw new HttpError(404, 'not_found');
  const { from, to } = TRANSITIONS[m.action];
  if (c.status !== from) throw invalid();
  const reason = m.reason?.trim() || null;
  if (REASON_REQUIRED.has(m.action) && (reason?.length ?? 0) < 10) throw new HttpError(422, 'reason_required', 'A reason of at least 10 characters is required');
  const { count } = await tx.claim.updateMany({ where: { id: m.claimId, status: from }, data: { ...m.set, status: to } });
  if (count !== 1) throw invalid();
  await m.beforeAppend?.();
  await appendEvent(tx, { claimId: m.claimId, actorId: m.actorId, action: m.action, fromStatus: from, toStatus: to, reason, at: m.now });
  return { action: m.action === 'withdraw' ? 'withdrawn' : m.action, from, to };
}
