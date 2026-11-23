import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { HttpError } from '../middleware.js';

export const COST = 12;
export const randomToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hashPassword = (pw: string): Promise<string> => bcrypt.hash(pw, COST);
export const needsRehash = (h: string): boolean => bcrypt.getRounds(h) < COST;

let dummy: Promise<string> | undefined;
const DUMMY_HASH = () => (dummy ??= bcrypt.hash(randomToken(), COST));

// Always costs one cost-12 compare: no/over-long password or no real hash compares against the dummy (NFR-SEC-6).
export async function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  const real = hash !== null && Buffer.byteLength(pw, 'utf8') <= 72;
  const ok = await bcrypt.compare(real ? pw : '', real ? hash : await DUMMY_HASH());
  return real && ok;
}

// C-13: length in characters (code points) >= 12, size in UTF-8 bytes <= 72 (bcrypt limit).
export function checkPassword(pw: unknown): asserts pw is string {
  const reason = typeof pw !== 'string' || [...pw].length < 12 ? 'Password must be at least 12 characters'
    : Buffer.byteLength(pw, 'utf8') > 72 ? 'Password must be at most 72 bytes' : null;
  if (reason) throw new HttpError(400, 'invalid_password', reason);
}
