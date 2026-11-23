import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { serializeError, type Logger } from './logger.js';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly reason?: string, public readonly extra?: Record<string, unknown>) {
    super(code);
    this.name = 'HttpError';
  }
}

export const requestLog = (log: Logger): RequestHandler => (req, res, next) => {
  const requestId = randomUUID();
  const start = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('close', () => {
    const status = res.statusCode;
    log.log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
      requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status,
      duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
      ...res.locals.logFields, // auth events etc. (ADR-5): fields on the one line, never extra lines
      ...(status >= 500 && 'error' in res.locals ? { error: serializeError(res.locals.error) } : {}),
    });
  });
  next();
};

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found' });
};

// Never emits err.message; 5xx errors are stashed for the access line. Parser errors (which carry the raw body) are never logged.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    // Express's default handler would print the stack (with message) to stderr; log via the access line instead.
    res.locals.error = err;
    res.statusCode = 500;
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) res.locals.error = err;
    res.status(err.status).json(err.status < 500 ? { error: err.code, ...(err.reason ? { reason: err.reason } : {}), ...err.extra } : { error: err.code });
    return;
  }
  const s = err?.status ?? err?.statusCode;
  if (typeof s === 'number' && s >= 400 && s <= 499) {
    res.status(s).json({ error: 'bad_request' });
  } else {
    res.locals.error = err;
    res.status(500).json({ error: 'internal_error', requestId: res.locals.requestId });
  }
};
