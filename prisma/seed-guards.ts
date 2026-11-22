export type SeedGuardFailure = { code: string; message: string };

// Pure: no DB access. Guards run in order; first failure wins.
export function checkSeedGuards(env: NodeJS.ProcessEnv): SeedGuardFailure | null {
  if (env.NODE_ENV === 'production') {
    return { code: 'SEED_REFUSED_PRODUCTION', message: 'seed must not run in production' };
  }
  const url = env.DATABASE_URL;
  if (!url) {
    return { code: 'SEED_REFUSED_NON_LOCAL_DB', message: 'DATABASE_URL is not set' };
  }
  if (!url.startsWith('file:')) {
    return { code: 'SEED_REFUSED_NON_LOCAL_DB', message: 'DATABASE_URL must be a local SQLite file: URL' };
  }
  if (!env.SEED_PASSWORD) {
    return { code: 'SEED_PASSWORD_MISSING', message: 'SEED_PASSWORD is not set' };
  }
  return null;
}
