import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

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
