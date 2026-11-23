import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../api/src/logger.js';

test('AC-4 every new SENSITIVE key is redacted', () => {
  const keys = ['sid', 'csrfToken', 'x-csrf-token', 'passwordHash', 'tokenHash', 'idHash'];
  const o = redact(Object.fromEntries(keys.map((k) => [k, 'secret'])));
  for (const k of keys) assert.equal((o as Record<string, string>)[k], '[REDACTED]', k);
});
