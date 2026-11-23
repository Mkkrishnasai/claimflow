import { test, expect } from 'vitest';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptStorage, sniff, UUID_RE } from './receipt-storage.js';
import { loadConfig, ConfigError } from '../config.js';

test('sniff by signature only', () => {
  expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).toBe('image/png');
  expect(sniff(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
  for (const s of ['GIF89a', 'PK\x03\x04', '<html>', 'hello', '']) expect(sniff(Buffer.from(s))).toBeNull();
});

test('put writes <uuid> with mode 0600, remove deletes, bad keys ignored, failure leaks nothing', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rs-')), 'r');
  const st = receiptStorage(dir);
  st.ensureDir();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const key = await st.put(Buffer.from('%PDF-x'));
  expect(key).toMatch(UUID_RE);
  expect(readdirSync(dir)).toEqual([key]);
  expect(statSync(join(dir, key)).mode & 0o777).toBe(0o600);
  await st.remove('../etc/passwd');
  await st.remove(key);
  expect(readdirSync(dir)).toEqual([]);
  const broken = receiptStorage(join(dir, 'missing'));
  await expect(broken.put(Buffer.from('x'))).rejects.toThrow(/^receipt_write_failed$/);
});

test('RECEIPTS_DIR: default, empty, outside web/, inside web/', () => {
  const ok = { DATABASE_URL: 'file:./x.db', SMTP_HOST: 'h', SMTP_PORT: '1025' };
  const d = loadConfig(ok).receiptsDir;
  expect(d.endsWith('/data/receipts')).toBe(true);
  expect(loadConfig({ ...ok, RECEIPTS_DIR: '' }).receiptsDir).toBe(d);
  expect(loadConfig({ ...ok, RECEIPTS_DIR: '/tmp/r' }).receiptsDir).toBe('/tmp/r');
  const web = d.replace(/data\/receipts$/, 'web');
  for (const bad of [web, `${web}/uploads`]) {
    expect(() => loadConfig({ ...ok, RECEIPTS_DIR: bad })).toThrow(expect.objectContaining({ variable: 'RECEIPTS_DIR', message: 'RECEIPTS_DIR must be outside web/' }));
  }
  expect(ConfigError).toBeDefined();
});
