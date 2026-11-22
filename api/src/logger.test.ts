import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, serializeError } from './logger.js';

const capture = () => {
  const lines: string[] = [];
  return { lines, log: createLogger({ write: (s: string) => lines.push(s) }) };
};

test('AC-1: listed keys redacted at any depth, mixed case, arrays, circular', () => {
  const { lines, log } = capture();
  const o: Record<string, unknown> = {
    Password: 'V1', RECEIPT: 'V2', bankAccount: 'V3', sortCode: 'V4',
    nested: { deep: [{ Authorization: 'V5', cookie: 'V6' }, { token: 'V7' }] },
  };
  o.self = o;
  log.info('x', o);
  const out = lines.join('');
  for (let i = 1; i <= 7; i++) assert.ok(!out.includes(`V${i}`));
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('"self":"[Circular]"'));
});

test('AC-2: variant names are not redacted', () => {
  const { lines, log } = capture();
  log.info('x', { accessToken: 'A', passwordConfirm: 'B', bank_account: 'C' });
  const o = JSON.parse(lines[0]);
  assert.deepEqual([o.accessToken, o.passwordConfirm, o.bank_account], ['A', 'B', 'C']);
});

test('serializeError: no message/cause text, header stripped, fails closed', () => {
  const e = new Error('m\n    at MARKER_1', { cause: new Error('CAUSE') });
  Object.assign(e, { context: { password: 'P', ok: 1 } });
  const s = JSON.stringify(serializeError(e));
  assert.ok(!/MARKER_1|CAUSE/.test(s));
  assert.ok(s.includes('[REDACTED]') && !s.includes('"P"'));
  const changed = new Error('a');
  void changed.stack; // V8 formats lazily; materialise before mutating
  changed.message = 'b\n    at MARKER_2';
  assert.deepEqual(serializeError(changed).stack, []);
  assert.deepEqual(redact({ e: changed }).e.stack, []);
});
