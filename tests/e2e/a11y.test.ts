import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WEB = 'http://127.0.0.1:5173';
const MAIL = 'http://127.0.0.1:8025';
const PW = 'correct horse battery';
const NEW_PW = 'brand-new-password';
const dir = mkdtempSync(join(tmpdir(), 'a11y-'));
let proc: ChildProcess;
let browser: Browser;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function apiAs(email: string, password: string) {
  const c = await fetch(`${WEB}/api/auth/csrf`);
  const csrf = ((await c.json()) as { csrfToken: string }).csrfToken;
  const pre = c.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(`${WEB}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: pre }, body: JSON.stringify({ email, password }) });
  const body = (await r.json()) as { csrfToken: string };
  return { csrf: body.csrfToken, cookie: r.headers.getSetCookie()[0].split(';')[0] };
}
async function mailLink(to: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = (await (await fetch(`${MAIL}/api/v1/messages`)).json()) as { messages: { ID: string; To: { Address: string }[] }[] };
    const m = list.messages.find((x) => x.To[0].Address === to);
    if (m) {
      const text = ((await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json()) as { Text: string }).Text;
      return text.match(/https?:\/\/\S+/)![0];
    }
    await sleep(200);
  }
  throw new Error('no mail');
}
const phone = async () => (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
async function clean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(bad.map((v) => v.id), [], label);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: horizontal scroll`);
}

before(async () => {
  proc = spawn('npm', ['start', '--silent'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: `file:${join(dir, 't.db')}`, SEED_PASSWORD: PW, DOTENV_CONFIG_PATH: join(dir, 'none'), NODE_ENV: 'development' },
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${WEB}/api/auth/csrf`)).ok && (await fetch(`${MAIL}/`)).ok) break; } catch {}
    assert.ok(i < 300, 'stack did not start');
    await sleep(200);
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  try { process.kill(-proc.pid!, 'SIGTERM'); } catch {}
  await sleep(1000);
  rmSync(dir, { recursive: true, force: true });
});

test('AC-5 axe 0 serious/critical and no horizontal scroll at 360 px', async () => {
  const page = await phone();
  for (const p of ['/sign-in', '/set-password#token=x', '/forgot-password']) {
    await page.goto(WEB + p);
    await page.locator('form').waitFor();
    await clean(page, p);
    for (const id of await page.locator('input').evaluateAll((els) => els.map((e) => e.id))) {
      assert.equal(await page.locator(`label[for="${id}"]:visible`).count(), 1, `${p} label for #${id}`);
    }
  }
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'employee@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter'); // keyboard-only submit
  await page.getByRole('heading', { name: 'ClaimFlow' }).waitFor();
  await clean(page, 'signed in');
});

test('AC-1/4 role routing and session restore; 401 routes to sign-in', async () => {
  const page = await phone();
  for (const [email, expected] of [['admin@claimflow.test', /^\/users$/], ['finance@claimflow.test', /^\/users\/.+/]] as const) {
    await page.goto(WEB + '/sign-in');
    await page.fill('#email', email);
    await page.fill('#password', PW);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => expected.test(u.pathname));
    const session = page.waitForResponse((r) => r.url().endsWith('/api/auth/session'));
    await page.reload();
    assert.equal((await session).status(), 200);
    await page.getByRole('heading', { name: 'ClaimFlow' }).waitFor();
    await page.context().clearCookies();
    await page.evaluate(() => fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    await page.goto(WEB + '/users');
    await page.waitForURL('**/sign-in');
    await page.context().clearCookies();
  }
});

test('AC-2/3 link to signed in < 2 min; error states', async () => {
  const t0 = Date.now();
  const admin = await apiAs('admin@claimflow.test', PW);
  const email = 'newbie@claimflow.test';
  const r = await fetch(`${WEB}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': admin.csrf, cookie: admin.cookie }, body: JSON.stringify({ name: 'Newbie', email, role: 'employee' }) });
  assert.equal(r.status, 201);
  const id = ((await r.json()) as { id: string }).id;
  const link = await mailLink(email);
  const page = await phone();

  await page.goto(link);
  await page.fill('#password', 'short');
  await page.evaluate(() => document.querySelector('form')!.noValidate = true);
  await page.click('button[type=submit]');
  assert.match(await page.getByRole('alert').innerText(), /at least 12/);

  await page.fill('#password', NEW_PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname === '/sign-in');
  assert.ok(page.url().includes('?email='));
  await page.fill('#email', email);
  await page.fill('#password', 'wrong-password-here');
  await page.click('button[type=submit]');
  const generic = await page.getByRole('alert').innerText();
  await page.fill('#password', NEW_PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname === `/users/${id}`);
  assert.ok(Date.now() - t0 < 120_000);

  // spent link is now "expired"
  await page.context().clearCookies();
  await page.goto(link);
  await page.fill('#password', NEW_PW);
  await page.click('button[type=submit]');
  assert.match(await page.getByRole('alert').innerText(), /invalid or has expired/);

  // locked account: same generic message
  for (let i = 0; i < 6; i++) {
    await page.goto(WEB + '/sign-in');
    await page.fill('#email', email);
    await page.fill('#password', 'wrong-password-here');
    await page.click('button[type=submit]');
    await page.getByRole('alert').waitFor();
  }
  await page.fill('#password', NEW_PW);
  await page.click('button[type=submit]');
  assert.equal(await page.getByRole('alert').innerText(), generic);

  // forgot-password: same text for known and unknown
  const texts: string[] = [];
  for (const e of [email, 'nobody@claimflow.test']) {
    await page.goto(WEB + '/forgot-password');
    await page.fill('#email', e);
    await page.click('button[type=submit]');
    texts.push(await page.getByRole('status').innerText());
  }
  assert.equal(texts[0], texts[1]);
});
