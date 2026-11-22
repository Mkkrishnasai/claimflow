import { test, expect } from 'vitest';
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
  for (let i = 1; i <= 7; i++) expect(!out.includes(`V${i}`)).toBeTruthy();
  expect(out.includes('[REDACTED]')).toBeTruthy();
  expect(out.includes('"self":"[Circular]"')).toBeTruthy();
});

test('AC-2: variant names are not redacted', () => {
  const { lines, log } = capture();
  log.info('x', { accessToken: 'A', passwordConfirm: 'B', bank_account: 'C' });
  const o = JSON.parse(lines[0]);
  expect([o.accessToken, o.passwordConfirm, o.bank_account]).toEqual(['A', 'B', 'C']);
});

test('serializeError: no message/cause text, header stripped, fails closed', () => {
  const e = new Error('m\n    at MARKER_1', { cause: new Error('CAUSE') });
  Object.assign(e, { context: { password: 'P', ok: 1 } });
  const s = JSON.stringify(serializeError(e));
  expect(!/MARKER_1|CAUSE/.test(s)).toBeTruthy();
  expect(s.includes('[REDACTED]') && !s.includes('"P"')).toBeTruthy();
  const changed = new Error('a');
  void changed.stack; // V8 formats lazily; materialise before mutating
  changed.message = 'b\n    at MARKER_2';
  expect(serializeError(changed).stack).toEqual([]);
  expect(redact({ e: changed }).e.stack).toEqual([]);
});

test('F-001: non-plain objects never leak sensitive keys', () => {
  class Creds { password = 'CLS_PW'; }
  const { lines, log } = capture();
  log.info('x', { c: new Creds(), m: new Map([['password', 'MAP_PW']]), s: new Set(['SET_PW']), b: Buffer.from('BUF_PW') });
  const out = lines.join('');
  expect(/CLS_PW|MAP_PW|SET_PW|BUF_PW/.test(out)).toBe(false);
  expect(JSON.parse(out).c).toBe('[Unserializable]');
});

test('F-002: subclass setting name in constructor keeps frames', () => {
  class MyErr extends Error { constructor(m: string) { super(m); this.name = 'MyErr'; } }
  const s = serializeError(new MyErr('boom'));
  expect(s.name).toBe('MyErr');
  expect((s.stack as string[]).length).toBeGreaterThan(0);
});

test('F-005: serialisation failure emits fixed line; core fields win', () => {
  const { lines, log } = capture();
  log.info('x', { big: 1n });
  expect(JSON.parse(lines[0]).msg).toBe('log_serialization_failed');
  log.info('real', { msg: 'spoof', level: 'debug', timestamp: 'x' });
  const o = JSON.parse(lines[1]);
  expect([o.msg, o.level]).toEqual(['real', 'info']);
  expect(o.timestamp).not.toBe('x');
});

test('Date with custom toJSON/toISOString cannot bypass redaction', () => {
  const secret = 'S3CRET-DATE';
  class EvilDate extends Date {
    toJSON(): any { return { password: secret }; }
    toISOString() { return secret; }
  }
  const d = new Date(0);
  (d as unknown as { toJSON: () => unknown }).toJSON = () => ({ password: secret });
  const lines: string[] = [];
  createLogger({ write: (s) => lines.push(s) }).info('x', { a: new EvilDate(0), b: d, c: new Date(NaN) });
  const out = lines.join('');
  expect(out).not.toContain(secret);
  expect(JSON.parse(out)).toMatchObject({ a: '1970-01-01T00:00:00.000Z', b: '1970-01-01T00:00:00.000Z', c: '[Invalid Date]' });
});
