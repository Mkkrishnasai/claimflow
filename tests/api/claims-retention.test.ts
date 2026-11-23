import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const src = files('api/src').filter((f) => f.endsWith('.ts'));

test('AC-5 only the draft, line and receipt delete paths remove claim data', () => {
  const hits: string[] = [];
  for (const f of src) readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/\.(claim|claimLine|receipt|claimEvent)\.(delete|deleteMany)\(/.test(l)) hits.push(`${f}:${i + 1}:${l.trim()}`); });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.startsWith('api/src/claims/service.ts:')), hits.join('\n'));
  assert.ok(!hits.some((h) => /claimEvent/.test(h)), 'nothing deletes ClaimEvent');
  const svc = readFileSync('api/src/claims/service.ts', 'utf8');
  // Each remaining delete sits inside deleteLine, deleteClaim or deleteReceipt.
  const owner = (line: number) => svc.split('\n').slice(0, line).reverse().find((l) => /^export const \w+/.test(l))?.match(/^export const (\w+)/)?.[1];
  for (const h of hits) assert.ok(['deleteLine', 'deleteClaim', 'deleteReceipt'].includes(owner(Number(h.split(':')[1]))!), h);
});

test('AC-5 no timer or schedule in api/src removes data', () => {
  const found = src.filter((f) => /setInterval|node-cron|\bcron\b|schedule\(/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(found, []);
});

test('AC-5 every foreign key from claim tables is Restrict', async () => {
  const prisma = new PrismaClient();
  try {
    for (const t of ['Claim', 'ClaimLine', 'Receipt', 'ClaimEvent']) {
      const fks = await prisma.$queryRawUnsafe<{ table: string; on_delete: string }[]>(`SELECT "table", on_delete FROM pragma_foreign_key_list('${t}')`);
      assert.ok(fks.length > 0, t);
      for (const fk of fks) assert.equal(fk.on_delete, 'RESTRICT', `${t} -> ${fk.table}`);
    }
  } finally { await prisma.$disconnect(); }
});
