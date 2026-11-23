import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Forbidden tokens are assembled so this file never matches itself; it is skipped by name anyway.
const BANNED = [['parse', 'Float'], ['to', 'Fixed'], ['Math.', 'round'], ['Math.', 'floor'], ['* ', '100'], ['/ ', '100']].map((p) => p.join(''));

test('claims code has no float money arithmetic', () => {
  const hits: string[] = [];
  for (const f of readdirSync(import.meta.dirname, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
    const src = readFileSync(join(import.meta.dirname, f), 'utf8');
    for (const t of BANNED) if (src.includes(t)) hits.push(`${f}: ${t}`);
  }
  expect(hits).toEqual([]);
});
