import type { Action, Status } from '../../../api/src/claims/status'; // type-only: nothing server-side is bundled

// C-51: one place that turns stored values into human text. Unknown values throw so raw text never reaches the DOM.
export type Tone = 'draft' | 'submitted' | 'approved' | 'rejected' | 'ready' | 'paid';
export const STATUS: Record<Status, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'draft' },
  submitted: { label: 'Submitted', tone: 'submitted' },
  approved: { label: 'Approved (awaiting second approval)', tone: 'approved' },
  rejected: { label: 'Rejected', tone: 'rejected' },
  ready_to_pay: { label: 'Ready to pay', tone: 'ready' },
  paid: { label: 'Paid', tone: 'paid' },
};

const own = <T extends object>(m: T, k: string, what: string): T[keyof T] => {
  if (!Object.hasOwn(m, k)) throw new Error(`Unknown ${what}: ${k}`);
  return m[k as keyof T];
};

export const statusInfo = (s: string) => own(STATUS, s, 'status');
export const statusLabel = (s: string) => statusInfo(s).label;

export const ACTION_LABEL: Record<Action | 'reassigned', string> = {
  submit: 'Submitted', resubmit: 'Resubmitted', withdraw: 'Withdrawn', approve_first: 'First approval',
  approve_final: 'Approved', reject: 'Rejected', approve_second: 'Second approval', reject_second: 'Rejected at second approval',
  send_back: 'Sent back by finance', pay: 'Paid', reassigned: 'Reassigned',
};
export const actionLabel = (a: string) => own(ACTION_LABEL, a, 'action');

const STAGE: Record<string, Status> = { first: 'submitted', second: 'approved' };
export const stageStatus = (stage: string): Status => own(STAGE, stage, 'stage');
