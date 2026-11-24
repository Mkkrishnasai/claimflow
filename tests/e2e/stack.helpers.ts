import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const WEB = 'http://127.0.0.1:5173';
export const mailpit = 'http://127.0.0.1:8025';
export const PW = 'correct horse battery';
export const NEW_PW = 'brand-new-password';
const dir = mkdtempSync(join(tmpdir(), 'a11y-'));
let proc: ChildProcess;
let browser: Browser;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startStack() {
  await fetch(`${mailpit}/api/v1/messages`, { method: 'DELETE' }).catch(() => {}); // no stale mail from earlier runs
  proc = spawn('npm', ['start', '--silent'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: `file:${join(dir, 't.db')}`, RECEIPTS_DIR: join(dir, 'receipts'), SEED_PASSWORD: PW, DOTENV_CONFIG_PATH: join(dir, 'none'), NODE_ENV: 'development' },
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${WEB}/api/auth/csrf`)).ok && (await fetch(`${mailpit}/`)).ok) break; } catch {}
    assert.ok(i < 300, 'stack did not start');
    await sleep(200);
  }
  browser = await chromium.launch();
}
export async function stopStack() {
  await browser?.close();
  try { process.kill(-proc.pid!, 'SIGTERM'); } catch {}
  await sleep(1000);
  rmSync(dir, { recursive: true, force: true });
}

export async function apiAs(email: string, password: string) {
  const c = await fetch(`${WEB}/api/auth/csrf`);
  const csrf = ((await c.json()) as { csrfToken: string }).csrfToken;
  const pre = c.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(`${WEB}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: pre }, body: JSON.stringify({ email, password }) });
  const body = (await r.json()) as { csrfToken: string };
  return { csrf: body.csrfToken, cookie: r.headers.getSetCookie()[0].split(';')[0] };
}
export async function mailLink(to: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: { ID: string; To: { Address: string }[] }[] };
    const m = list.messages.find((x) => x.To[0].Address === to);
    if (m) {
      const text = ((await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json()) as { Text: string }).Text;
      return text.match(/https?:\/\/\S+/)![0];
    }
    await sleep(200);
  }
  throw new Error('no mail');
}
export const phone = async () => (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
// Strict by default: all four WCAG tags, every impact (the lenient mode is gone, CLAIM-9 FR-5 AC-1).
export async function clean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  assert.deepEqual(violations.map((v) => v.id), [], label);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: horizontal scroll`);
}
// Tab until the target (CSS selector or Locator) has focus (keyboard reachability); fails with `label` after `max` presses.
export async function tabTo(page: Page, target: string | Locator, max = 50, label = String(target)) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  for (let i = 0; i < max; i++) {
    if (await loc.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`${label}: target not reachable by Tab`);
}
