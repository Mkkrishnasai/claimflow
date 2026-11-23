import { expect, test } from 'vitest';
import { parseLine } from './service.js';

const cats = new Set(['meals']);
const base = { date: '2026-01-01', categoryCode: 'meals', amountCents: 5001, description: 'd' };

test('parseLine: justification trimmed, blank and null become null, 501 chars refused', () => {
  expect(parseLine({ ...base, justification: ' abc ' }, cats).justification).toBe('abc');
  expect(parseLine({ ...base, justification: '   ' }, cats).justification).toBeNull();
  expect(parseLine({ ...base, justification: null }, cats).justification).toBeNull();
  expect(parseLine({ ...base, justification: 'x'.repeat(500) }, cats).justification).toHaveLength(500);
  expect(() => parseLine({ ...base, justification: 'x'.repeat(501) }, cats)).toThrow(expect.objectContaining({ status: 422, code: 'invalid_input' }));
});
