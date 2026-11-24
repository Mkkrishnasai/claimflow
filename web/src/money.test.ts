import { expect, test } from 'vitest';
import { formatCents, justificationFor, parseEuro } from './money';

test('parseEuro accepts valid amounts by string', () => {
  expect(['12', '12.5', '12,50', '1250.00', '10000', '0.05'].map(parseEuro)).toEqual([1200, 1250, 1250, 125000, 1000000, 5]);
});
test('parseEuro rejects bad amounts', () => {
  for (const s of ['abc', '1.234', '-1', '10000.01', '', '0', '1e2', '12.']) expect(parseEuro(s), s).toBeNull();
});
test('formatCents', () => {
  expect([1250, 5, 0, 125000].map(formatCents)).toEqual(['EUR 12.50', 'EUR 0.05', 'EUR 0.00', 'EUR 1250.00']);
});
test('justification is sent only above the limit', () => {
  expect(justificationFor(5001, 5000, ' because ')).toBe('because');
  expect(justificationFor(5001, 5000, '  ')).toBeNull();
  expect(justificationFor(5000, 5000, 'stale text')).toBeNull();
});
