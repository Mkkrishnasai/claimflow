export class ConfigError extends Error {
  constructor(public readonly variable: string, reason = 'is required') {
    super(`${variable} ${reason}`);
    this.name = 'ConfigError';
  }
}

export interface Config {
  readonly databaseUrl: string;
  readonly smtp: { readonly host: string; readonly port: number; readonly user?: string; readonly pass?: string };
}

// Empty string counts as unset. Errors name variables, never values.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (k: string) => (env[k] === '' ? undefined : env[k]);
  const req = (k: string) => {
    const v = get(k);
    if (v === undefined) throw new ConfigError(k);
    return v;
  };
  const databaseUrl = req('DATABASE_URL');
  const host = req('SMTP_HOST');
  const portStr = req('SMTP_PORT');
  const port = Number(portStr);
  if (!/^\d+$/.test(portStr) || port < 1 || port > 65535) throw new ConfigError('SMTP_PORT', 'must be an integer 1-65535');
  const user = get('SMTP_USER');
  const pass = get('SMTP_PASS');
  return Object.freeze({ databaseUrl, smtp: Object.freeze({ host, port, user, pass }) });
}
