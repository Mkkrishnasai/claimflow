import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class ConfigError extends Error {
  constructor(public readonly variable: string, reason = 'is required') {
    super(`${variable} ${reason}`);
    this.name = 'ConfigError';
  }
}

export interface Config {
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly receiptsDir: string;
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
  const rawBase = get('PUBLIC_BASE_URL') ?? 'http://127.0.0.1:5173';
  let publicBaseUrl: string;
  try {
    const u = new URL(rawBase);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    publicBaseUrl = rawBase.replace(/\/+$/, '');
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL', 'must be an http(s) URL');
  }
  const repo = resolve(fileURLToPath(import.meta.url), '../../..');
  const receiptsDir = resolve(repo, get('RECEIPTS_DIR') ?? 'data/receipts');
  const inWeb = relative(resolve(repo, 'web'), receiptsDir);
  if (inWeb === '' || (!inWeb.startsWith('..') && !isAbsolute(inWeb))) throw new ConfigError('RECEIPTS_DIR', 'must be outside web/');
  return Object.freeze({ databaseUrl, publicBaseUrl, receiptsDir, smtp: Object.freeze({ host, port, user, pass }) });
}
