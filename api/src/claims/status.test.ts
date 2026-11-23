import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ACTIONS, nextStatus, TRANSITIONS } from './status.js';

const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'ready_to_pay', 'paid'];

test('AC-1: of 60 action/status combinations exactly the 10 table rows are allowed', () => {
  const ok = ACTIONS.flatMap((a) => STATUSES.map((s) => [a, s, nextStatus(s, a)] as const)).filter((x) => x[2]);
  expect(ok.length).toBe(10);
  expect(ok.map((x) => x[0]).sort()).toEqual([...ACTIONS].sort());
  expect(new Set(ok.map((x) => `${x[1]}>${x[2]}`)).size).toBe(10); // spec says 9 but its own table has 10 distinct (from, to) pairs
});

test('AC-1: withdrawn is not a ClaimStatus', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const members = /enum ClaimStatus \{([^}]*)\}/.exec(schema)![1].split(/\s+/).filter(Boolean);
  expect(members).toEqual(STATUSES);
  expect(Object.values(TRANSITIONS).flatMap((t) => [t.from, t.to]).includes('withdrawn' as never)).toBe(false);
});
