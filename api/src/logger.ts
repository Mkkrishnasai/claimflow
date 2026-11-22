export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE = new Set(['password', 'receipt', 'bankaccount', 'sortcode', 'authorization', 'cookie', 'token']);

// Stack frames only; the String(err) header (message, may hold newlines) is dropped. Fails closed to [].
function frames(err: Error): string[] {
  try {
    const header = String(err);
    if (typeof err.stack !== 'string' || !err.stack.startsWith(header)) return [];
    return err.stack.slice(header.length).split('\n').filter((l) => /^\s+at /.test(l));
  } catch {
    return [];
  }
}

// Never emits message or cause text (ADR-4); only cause's name.
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { name: 'NonError', stack: [] };
  const out: Record<string, unknown> = {
    name: err.name,
    context: redact((err as { context?: unknown }).context),
    stack: frames(err),
  };
  if (err.cause !== undefined) out.cause = { name: err.cause instanceof Error ? err.cause.name : typeof err.cause };
  return out;
}

export function redact<T>(v: T): T {
  const path = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x instanceof Error) return serializeError(x);
    if (x === null || typeof x !== 'object') return x;
    const proto = Object.getPrototypeOf(x);
    if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) return x;
    if (path.has(x)) return '[Circular]';
    path.add(x);
    const out = Array.isArray(x)
      ? x.map(walk)
      : Object.fromEntries(
          Object.entries(x).map(([k, val]) => [k, SENSITIVE.has(k.toLowerCase()) ? '[REDACTED]' : walk(val)]),
        );
    path.delete(x);
    return out;
  };
  return walk(v) as T;
}

export function createLogger(stream: { write(s: string): unknown } = process.stdout): Logger {
  const log = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    stream.write(JSON.stringify(redact({ timestamp: new Date().toISOString(), level, msg, ...fields })) + '\n');
  };
  return {
    log,
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
