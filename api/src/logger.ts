export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE = new Set(['password', 'receipt', 'bankaccount', 'sortcode', 'authorization', 'cookie', 'token', 'sid', 'csrftoken', 'x-csrf-token', 'passwordhash', 'tokenhash', 'idhash']);

// Stack frames only; the header (message, may hold newlines) is dropped. Fails closed to [].
// Limit: V8 builds the header at construction, so we try String(err) plus constructor-name and 'Error' headers;
// a name changed after construction (not in the constructor) or a mutated message yields [].
function frames(err: Error): string[] {
  try {
    const hdr = (n: string) => (err.message ? `${n}: ${err.message}` : n);
    const ctor = (Object.getPrototypeOf(err)?.constructor as { name?: string } | undefined)?.name ?? 'Error';
    const header = [String(err), hdr(ctor), hdr('Error')].find((h) => typeof err.stack === 'string' && err.stack.startsWith(h));
    if (header === undefined) return [];
    return err.stack!.slice(header.length).split('\n').filter((l) => /^\s+at /.test(l));
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
    // Non-plain objects (class instances, Map, Set, Buffer...) may hide sensitive keys. Dates (incl. subclasses) are
    // converted with the trusted prototype method so a custom toJSON/toISOString cannot smuggle secrets.
    if (x instanceof Date) {
      try { return Date.prototype.toISOString.call(x); } catch { return '[Invalid Date]'; }
    }
    if (!Array.isArray(x) && proto !== Object.prototype && proto !== null) return '[Unserializable]';
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
    let line: string;
    try {
      line = JSON.stringify(redact({ ...fields, timestamp: new Date().toISOString(), level, msg }));
    } catch {
      line = JSON.stringify({ timestamp: new Date().toISOString(), level, msg: 'log_serialization_failed' });
    }
    stream.write(line + '\n');
  };
  return {
    log,
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
