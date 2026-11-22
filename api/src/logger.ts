export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ponytail: identity seam; key redaction lands in S4.
export const redact = <T>(v: T): T => v;

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
