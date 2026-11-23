import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

// C-25. Receipt bytes on local disk under a server-generated <uuid> name; filenames never reach a path.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type ReceiptMime = 'image/jpeg' | 'image/png' | 'application/pdf';

export interface ReceiptStore {
  ensureDir(): void;
  put(bytes: Buffer): Promise<string>;
  remove(key: string): Promise<void>;
  open(key: string): Promise<{ size: number; handle: FileHandle }>;
}

const SIGS: [ReceiptMime, number[]][] = [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
];

export const sniff = (b: Buffer): ReceiptMime | null =>
  SIGS.find(([, sig]) => b.length >= sig.length && sig.every((x, i) => b[i] === x))?.[0] ?? null;

export function receiptStorage(dir: string): ReceiptStore {
  return {
    ensureDir() {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    },
    async put(bytes) {
      const key = randomUUID();
      const tmp = join(dir, `.${key}.tmp`);
      try {
        const fh = await open(tmp, 'wx', 0o600);
        try { await fh.writeFile(bytes); } finally { await fh.close(); }
        await rename(tmp, join(dir, key));
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw new Error('receipt_write_failed'); // no path or name in the message
      }
      return key;
    },
    async open(key) {
      if (!UUID_RE.test(key)) throw new Error('receipt_missing');
      const handle = await open(join(dir, key), 'r');
      try { return { size: (await handle.stat()).size, handle }; } catch (e) { await handle.close(); throw e; }
    },
    async remove(key) {
      if (!UUID_RE.test(key)) return;
      await rm(join(dir, key), { force: true });
    },
  };
}
