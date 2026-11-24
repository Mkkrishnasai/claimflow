import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEB, PW, startStack, stopStack, page as newPage, tabTo, visitRoutes } from './stack.helpers.js';

before(startStack);
after(stopStack);

// Expected token values from the epic tables (same source as web/src/styles/design.test.ts); parsed from tokens.css so the 14 badge tokens are covered too.
const css = readFileSync(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8');
const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
const decls = (s: string) => Object.fromEntries([...s.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]));
const LIGHT = decls(css.slice(0, darkAt));
const DARK = { ...LIGHT, ...decls(css.slice(darkAt)) };
const ANCHOR = { light: { bg: '#F7F7FB', text: '#0B1026', primary: '#6D28D9' }, dark: { bg: '#0B1026', text: '#E8E9F5', primary: '#7C3AED' } };
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test('AC-2 computed theme tokens equal the light and dark values on every route', async () => {
  assert.ok(Object.keys(LIGHT).length >= 27, 'tokens parsed');
  for (const scheme of ['dark', 'light'] as const) {
    const want = scheme === 'dark' ? DARK : LIGHT;
    for (const [k, v] of Object.entries(ANCHOR[scheme])) assert.equal(want[k], v, `anchor ${scheme} --${k}`);
    await visitRoutes(async (page, route) => {
      const got = await page.evaluate((names) => { const s = getComputedStyle(document.documentElement); return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(`--${n}`).trim().toUpperCase()])); }, Object.keys(want));
      assert.deepEqual(got, want, `${route} ${scheme}`);
    }, { width: 360, scheme });
  }
});

test('AC-3 no raw values, money format and alignment, no sideways scroll on every route', () => visitRoutes(async (page, route) => {
  const r = await page.evaluate(() => {
    const text = document.body.innerText;
    const cells = [...document.querySelectorAll<HTMLElement>('td, th, dd, .num')].filter((e) => /^EUR\b/.test(e.textContent!.trim()));
    return {
      raw: text.match(/\b(ready_to_pay|approve_first|approve_final|approve_second|reject_second|send_back|resubmit)\b/g) ?? [],
      rawLeaf: [...document.querySelectorAll('*')].filter((e) => !e.children.length && /^(draft|submitted|approved|rejected|paid)$/.test(e.textContent!.trim())).map((e) => e.textContent),
      badMoney: text.match(/EUR(?! \d+\.\d{2}(?!\d))/g) ?? [],
      leftMoney: cells.filter((e) => /^EUR \d+\.\d{2}$/.test(e.textContent!.trim()) && !['right', 'end'].includes(getComputedStyle(e).textAlign)).map((e) => e.textContent),
      scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });
  assert.deepEqual(r, { raw: [], rawLeaf: [], badMoney: [], leftMoney: [], scroll: true }, route);
}));

const NAV: Record<string, string[]> = {
  employee: ['My claims', 'My account'], manager: ['My claims', 'Approvals', 'My account'],
  finance: ['My claims', 'Payments', 'Policy', 'Export', 'My account'], admin: ['My claims', 'Users', 'My account'],
};
test('AC-3 nav items match each role', async () => {
  for (const [role, want] of Object.entries(NAV)) {
    const p = await newPage({ width: 1280, scheme: 'light' });
    await p.goto(WEB + '/sign-in');
    await p.fill('#email', `${role}@claimflow.test`);
    await p.fill('#password', PW);
    await p.press('#password', 'Enter');
    await p.getByRole('navigation', { name: 'Main' }).waitFor();
    assert.deepEqual(await p.getByRole('navigation', { name: 'Main' }).getByRole('link').allInnerTexts(), want, role);
    await p.context().close();
  }
});

test('AC-3 auth screens: invalid field is aria-invalid, described by its error, and focused', async () => {
  for (const [path, width] of [['/sign-in', 1280], ['/sign-in', 360], ['/forgot-password', 1280], ['/forgot-password', 360], ['/set-password#token=x', 1280], ['/set-password#token=x', 360]] as const) {
    const p = await newPage({ width, scheme: 'light' });
    await p.goto(WEB + path);
    await p.locator('form button[type=submit]').click();
    const f = p.locator('input[aria-invalid=true]').first();
    await f.waitFor();
    const ok = await f.evaluate((el) => ({ focused: el === document.activeElement, text: (el.getAttribute('aria-describedby') ?? '').split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join('').trim() }));
    assert.ok(ok.focused, `${path}@${width} focus`);
    assert.ok(ok.text, `${path}@${width} describedby`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${path}@${width} scroll`);
    await p.context().close();
  }
});

test('AC-4 transitions <= 200 ms, none under reduced motion, visible primary focus ring', async () => {
  const ms = (s: string) => s.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000));
  const read = (p: import('@playwright/test').Page) => p.evaluate(() => [...document.querySelectorAll('a, button, input, select, textarea, li, tr')].flatMap((e) => { const s = getComputedStyle(e); return [s.transitionDuration, s.animationName === 'none' ? '0s' : s.animationDuration]; }));
  await visitRoutes(async (p, route) => { assert.ok(Math.max(0, ...(await read(p)).flatMap(ms)) <= 200, `${route} duration`); }, { width: 360, scheme: 'light' });
  const reduced = await (await (await import('./stack.helpers.js')).page({ width: 360, scheme: 'light' })).context().newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await reduced.goto(WEB + '/sign-in');
  await reduced.locator('#email').waitFor();
  assert.equal(Math.max(0, ...(await read(reduced)).flatMap(ms)), 0, 'reduced motion durations');
  assert.equal(await reduced.evaluate(() => document.getAnimations().length), 0, 'running animations');
  await reduced.keyboard.press('Tab');
  await tabTo(reduced, '#email');
  const ring = await reduced.locator('#email').evaluate((e) => ({ s: getComputedStyle(e).outlineStyle, w: getComputedStyle(e).outlineWidth, c: getComputedStyle(e).outlineColor, p: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() }));
  assert.ok(ring.s !== 'none' && parseFloat(ring.w) >= 2, 'focus ring visible');
  assert.equal(ring.c, rgb(LIGHT.primary), 'focus ring is --primary');
  await reduced.context().close();
});
