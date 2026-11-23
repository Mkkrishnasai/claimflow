import { expect, test } from 'vitest';
import { errorHandler, HttpError } from './middleware.js';

const call = (err: unknown) => {
  const r: { status?: number; body?: unknown } = {};
  const res = { headersSent: false, locals: { requestId: 'rid' }, status(s: number) { r.status = s; return this; }, json(b: unknown) { r.body = b; } };
  errorHandler(err, {} as never, res as never, (() => {}) as never);
  return r;
};

test('4xx merges extra; 4xx without extra is unchanged; 5xx ignores extra', () => {
  expect(call(new HttpError(422, 'validation_failed', '2 problems', { failures: [1] }))).toEqual({ status: 422, body: { error: 'validation_failed', reason: '2 problems', failures: [1] } });
  expect(JSON.stringify(call(new HttpError(409, 'no_manager', 'why')).body)).toBe('{"error":"no_manager","reason":"why"}');
  expect(JSON.stringify(call(new HttpError(404, 'not_found')).body)).toBe('{"error":"not_found"}');
  expect(call(new HttpError(500, 'boom', 'r', { secret: 1 })).body).toEqual({ error: 'boom' });
  expect(call(new Error('x')).body).toEqual({ error: 'internal_error', requestId: 'rid' });
});
