import { expect, test } from 'vitest';
import { HEADER, approversOf, cell, euro, paidClaimsCsv, type ExportLine } from './export.js';

const base = { claimId: 'c1', employee: 'Employee Eve', paymentDate: '2026-03-15', paymentReference: 'INV-0042' };
const ev = (action: string, actorName = 'x') => ({ claimId: 'c1', action, actorName });
const hist = [ev('submit', 'Eve'), ev('approve_first', 'Manager Mia'), ev('approve_second', 'Senior Sam')];

test('AC-1 one row per line, CRLF, no BOM, trailing CRLF', () => {
  const lines: ExportLine[] = [{ ...base, category: 'Meals', amountCents: 1250 }, { ...base, category: 'Travel', amountCents: 5 }];
  const { csv, rows } = paidClaimsCsv(lines, hist);
  expect(rows).toBe(2);
  expect(csv).toBe(`${HEADER}\r\nc1,Employee Eve,Manager Mia; Senior Sam,Meals,12.50,12.55,2026-03-15,INV-0042\r\nc1,Employee Eve,Manager Mia; Senior Sam,Travel,0.05,12.55,2026-03-15,INV-0042\r\n`);
  expect(csv.charCodeAt(0)).not.toBe(0xfeff);
});

test('AC-2 euro formats integer cents exactly', () => {
  expect([1, 5, 250000, 1000000, 0].map(euro)).toEqual(['0.01', '0.05', '2500.00', '10000.00', '0.00']);
  expect(euro(2 ** 31 + 7)).toBe('21474836.55');
  for (const c of [1, 99, 100, 123456789012]) expect(euro(c)).toMatch(/^\d+\.\d{2}$/);
});

test('AC-3 quoting and formula guard', () => {
  expect(cell('A, "B"')).toBe('"A, ""B"""');
  expect(cell('=HYPERLINK("x")').startsWith(`"'=`)).toBe(true);
  expect(cell('+Eve')).toBe("'+Eve");
  for (const c of ['-1', '@a', '\tx']) expect(cell(c)[0]).toBe("'");
  expect(cell('line\nbreak')).toBe('"line\nbreak"');
  const { csv } = paidClaimsCsv([{ ...base, employee: '+Eve', category: 'Meals', amountCents: 100, paymentReference: 'A, "B"' }], hist);
  expect(csv.split('\r\n')[1]).toBe(`c1,'+Eve,Manager Mia; Senior Sam,Meals,1.00,1.00,2026-03-15,"A, ""B"""`);
});

test('AC-4 approvers come from the last cycle only', () => {
  const again = [ev('submit'), ev('approve_first', 'Old'), ev('send_back'), ev('resubmit'), ev('approve_final', 'Fin')];
  expect(approversOf(again)).toEqual(['Fin']);
  expect(approversOf([ev('submit'), ev('approve_final', 'Solo')])).toEqual(['Solo']);
  expect(approversOf([ev('submit')])).toEqual([]);
  const { csv } = paidClaimsCsv([{ ...base, category: 'Meals', amountCents: 100 }], [ev('submit')]);
  expect(csv.split('\r\n')[1]).toBe('c1,Employee Eve,,Meals,1.00,1.00,2026-03-15,INV-0042');
});

test('AC-5 no email column in output', () => {
  const { csv } = paidClaimsCsv([{ ...base, category: 'Meals', amountCents: 100 }], hist);
  expect(csv).not.toMatch(/@/);
});
