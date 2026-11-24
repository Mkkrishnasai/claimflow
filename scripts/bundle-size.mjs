// Gzipped JS + CSS of the production build (fonts excluded); 1 KB = 1024 B. NFR-PERF-1.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const BUDGET_KB = 128.55;

export function bundleKb(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css)$/.test(e.name)) bytes += gzipSync(readFileSync(p)).length;
    }
  };
  walk(dir);
  return bytes / 1024;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'web/dist';
  let kb;
  try { kb = bundleKb(dir); } catch { console.error(`no build output at ${dir}; run npm run build first`); process.exit(2); }
  console.log(`gzipped JS + CSS: ${kb.toFixed(2)} KB (budget ${BUDGET_KB} KB)`);
  if (kb > BUDGET_KB) { console.error('over budget: drop Inter, then low-value icons'); process.exit(1); }
}
