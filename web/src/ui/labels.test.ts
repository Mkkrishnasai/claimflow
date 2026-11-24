import { describe, expect, it } from 'vitest';
import { ACTIONS, TRANSITIONS, type Status } from '../../../api/src/claims/status';
import { ACTION_LABEL, STATUS, actionLabel, stageStatus, statusLabel } from './labels';

const EXPECTED: Record<Status, string> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved (awaiting second approval)',
  rejected: 'Rejected', ready_to_pay: 'Ready to pay', paid: 'Paid',
};
const stored = [...new Set(Object.values(TRANSITIONS).flatMap((t) => [t.from, t.to]))];

describe('status labels (FR-9 AC-1)', () => {
  it('covers every status the state machine can store', () => {
    expect(stored.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(STATUS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
  it.each(Object.entries(EXPECTED))('%s -> %s', (s, label) => expect(statusLabel(s)).toBe(label));
  it('rejects an unknown value instead of returning raw text', () => {
    expect(() => statusLabel('pending')).toThrow();
    expect(() => statusLabel('')).toThrow();
    expect(() => statusLabel('toString')).toThrow(); // prototype keys are not statuses
  });
  it('maps approvals stages to statuses', () => {
    expect(stageStatus('first')).toBe('submitted');
    expect(stageStatus('second')).toBe('approved');
    expect(() => stageStatus('third')).toThrow();
  });
});

describe('action labels', () => {
  it('labels every action and reassignment, and rejects unknowns', () => {
    for (const a of [...ACTIONS, 'reassigned']) expect(actionLabel(a)).not.toBe(a);
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...ACTIONS, 'reassigned'].sort());
    expect(() => actionLabel('nope')).toThrow();
  });
});
