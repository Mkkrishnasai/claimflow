// npm run screenshots -- before|after → docs/ui-refresh/<set>/<screen>-{light,dark}-{1280,360}.png (not a *.test.ts, so the runner skips it)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startStack, stopStack, visitRoutes } from './stack.helpers.js';

const set = process.argv[2];
assert.ok(set === 'before' || set === 'after', 'usage: npm run screenshots -- before|after');
const out = `docs/ui-refresh/${set}`;
mkdirSync(out, { recursive: true });
// '/claims/:id/edit' -> 'claims-id-edit' (:id routes use the seeded claim/user id; naming is Open Question 6)
const screen = (route: string) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-');

await startStack();
try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 360]) {
      await visitRoutes(async (page, route) => { await page.screenshot({ path: `${out}/${screen(route)}-${scheme}-${width}.png`, fullPage: true }); }, { width, scheme });
    }
  }
} finally {
  await stopStack();
}
