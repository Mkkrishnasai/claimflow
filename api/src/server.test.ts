import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onFatal } from './server.js';
import type { Logger } from './logger.js';

test('AC-5: onFatal logs a scrubbed error and exits 1', () => {
  const logged: unknown[] = [];
  const log = { error: (m: string, f: unknown) => logged.push([m, f]) } as unknown as Logger;
  let code: number | undefined;
  const e = new Error('boom\n    at MARKER_1\n    at MARKER_2\n    at MARKER_3');
  onFatal(log, e, (c) => { code = c; });
  assert.equal(code, 1);
  assert.equal(logged.length, 1);
  assert.ok(!/MARKER_/.test(JSON.stringify(logged)));
});
