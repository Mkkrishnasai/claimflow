import { test, expect, vi } from 'vitest';
import { onFatal } from './server.js';
import type { Logger } from './logger.js';

test('AC-5: onFatal logs a scrubbed error and exits 1', () => {
  const logged: unknown[] = [];
  const log = { error: (m: string, f: unknown) => logged.push([m, f]) } as unknown as Logger;
  let code: number | undefined;
  const e = new Error('boom\n    at MARKER_1\n    at MARKER_2\n    at MARKER_3');
  onFatal(log, e, (c) => { code = c; });
  expect(code).toBe(1);
  expect(logged.length).toBe(1);
  expect(!/MARKER_/.test(JSON.stringify(logged))).toBeTruthy();
});

test('errorHandler with headersSent stores error, destroys response and does not call next', async () => {
  const { errorHandler } = await import('./middleware.js');
  const err = new Error('boom');
  const res = { headersSent: true, locals: {} as Record<string, unknown>, statusCode: 200, destroy: vi.fn() };
  const next = vi.fn();
  errorHandler(err, {} as never, res as never, next);
  expect(res.locals.error).toBe(err);
  expect(res.statusCode).toBe(500);
  expect(res.destroy).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
});
