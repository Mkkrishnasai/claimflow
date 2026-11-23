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
async function clean(page: Page, label: string, strict = false) {
  const { violations } = await (strict ? new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) : new AxeBuilder({ page })).analyze();
  const bad = strict ? violations : violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
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
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await clean(page, 'signed in');
});

test('AC-1/4 role routing and session restore; 401 routes to sign-in', async () => {
  const page = await phone();
  for (const [email, expected] of [['admin@claimflow.test', /^\/users$/], ['finance@claimflow.test', /^\/claims$/]] as const) {
    await page.goto(WEB + '/sign-in');
    await page.fill('#email', email);
    await page.fill('#password', PW);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => expected.test(u.pathname));
    const session = page.waitForResponse((r) => r.url().endsWith('/api/auth/session'));
    await page.reload();
    assert.equal((await session).status(), 200);
    await page.getByRole('heading', { name: expected.source.includes('claims') ? 'My claims' : 'Users' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
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
  await page.waitForURL((u) => u.pathname === '/claims');
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

test('S11 users list and detail: cards, actions, denial, a11y at 360 px', async () => {
  const admin = await apiAs('admin@claimflow.test', PW);
  const post = (path: string, body: unknown) => fetch(`${WEB}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': admin.csrf, cookie: admin.cookie }, body: JSON.stringify(body) });
  const r = await post('users', { name: 'Zed Pending', email: 'zed@claimflow.test', role: 'employee' });
  const zed = ((await r.json()) as { id: string }).id;
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'admin@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'Users' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  assert.equal(await page.locator('table').count(), 0);
  await page.locator('ul.cards li').nth(1).waitFor();
  await clean(page, '/users');

  await page.goto(`${WEB}/users/${zed}`);
  await page.getByRole('button', { name: 'Resend link' }).waitFor();
  await page.locator('label[for=manager]:visible').waitFor();
  await clean(page, '/users/:id');
  await page.focus('#manager');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Resend link'); // keyboard reachable
  await page.getByRole('button', { name: 'Deactivate' }).click();
  assert.match(await page.getByRole('status').innerText(), /0 moved \/ 0 notified/);
  assert.equal(await page.getByRole('button', { name: 'Resend link' }).count(), 0);

  // last admin refusal is shown in an alert
  const adminId = ((await (await fetch(`${WEB}/api/users`, { headers: { cookie: admin.cookie } })).json()) as { id: string; role: string }[]).find((u) => u.role === 'admin')!.id;
  await page.goto(`${WEB}/users/${adminId}`);
  await page.getByRole('button', { name: 'Deactivate' }).click();
  assert.match(await page.getByRole('alert').innerText(), /last active admin/);

  // non-admin: list denied, own record visible
  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  await emp.goto(WEB + '/users');
  assert.match(await emp.getByRole('alert').innerText(), /Access denied/);
});

test('S9 claims list and editor: capture, amounts, a11y at 360 px, keyboard', async () => {
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'finance@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await page.getByText('No claims yet').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await clean(page, '/claims', true);
  assert.equal(await page.getByRole('link', { name: 'My account' }).count(), 1);

  await page.getByRole('link', { name: 'New claim' }).click();
  await page.getByRole('heading', { name: 'New claim' }).waitFor();
  await page.locator('label[for=title]:visible').waitFor();
  for (const id of await page.locator('input:not([type=file]), select, textarea').evaluateAll((els) => els.map((e) => e.id))) {
    assert.equal(await page.locator(`label[for="${id}"]:visible`).count(), 1, `label for #${id}`);
  }
  await clean(page, '/claims/new', true);
  assert.ok((await page.locator('select option').first().innerText()).includes('limit EUR'));

  await page.fill('#title', 'Berlin trip');
  await page.fill('#purpose', 'Client workshop in Berlin');
  const date = page.locator('input[type=date]');
  await date.fill('2026-01-15');
  const amt = page.locator('input[id^=amt-]');
  await page.locator('input[id^=desc-]').fill('Taxi');
  await amt.fill('1.234');
  await page.getByRole('button', { name: 'Save claim' }).click();
  await page.locator('[id^=amt-err-]').waitFor();
  assert.match(page.url(), /\/claims\/new$/); // nothing sent
  await amt.fill('12,50');
  const save = page.getByRole('button', { name: 'Save claim' });
  await save.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/claims\/[^/]+\/edit$/);
  await page.getByRole('button', { name: 'Save claim' }).waitFor();
  assert.equal(await amt.inputValue(), '12.50');

  for (const b of await page.locator('label.button, button[type=submit]').all()) {
    const box = (await b.boundingBox())!;
    assert.ok(box.width >= 44 && box.height >= 44, 'tap target >= 44px');
  }
  assert.equal(await page.locator('input[capture=environment][accept="image/*"]').count(), 1);
  await clean(page, '/claims/:id/edit', true);

  // upload: valid PNG accepted, text file refused with the server's reason in an alert
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const files = page.locator('input[accept="image/jpeg,image/png,application/pdf"]');
  await files.setInputFiles({ name: 'r.png', mimeType: 'image/png', buffer: png });
  await page.getByText('r.png').waitFor();
  await page.getByRole('button', { name: /Remove receipt/ }).click();
  await page.getByText('r.png').waitFor({ state: 'detached' });
  await page.locator('input[accept="image/*"]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.locator('fieldset').getByRole('alert').waitFor();
  assert.match(await page.locator('fieldset').getByRole('alert').innerText(), /JPEG, PNG or PDF/);

  // unknown claim: server refusal shown, no editable fields (submitted claims need CLAIM-3-S6 to set up)
  await page.goto(WEB + '/claims/nope/edit');
  assert.match(await page.getByRole('alert').innerText(), /Claim not found/);
  assert.equal(await page.locator('input#title').count(), 0);
});

test('S10 claim detail: content, actions, no-manager, errors, a11y at 360 px', async () => {
  const mk = async (email: string) => {
    const s = await apiAs(email, PW);
    const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
    const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string; limitCents: number }[])[0];
    const line = (amountCents: number) => ({ date: '2026-01-15', categoryCode: cat.code, amountCents, description: 'Taxi' });
    const r = await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Detail trip', purpose: 'Client workshop in Berlin', lines: [line(100), line(cat.limitCents + 1)] }) });
    return ((await r.json()) as { id: string }).id;
  };
  const signIn = async (email: string) => {
    const p = await phone();
    await p.goto(WEB + '/sign-in');
    await p.fill('#email', email);
    await p.fill('#password', PW);
    await p.press('#password', 'Enter');
    await p.getByRole('heading', { name: 'My claims' }).waitFor();
    return p;
  };
  const id = await mk('employee@claimflow.test');
  const page = await signIn('employee@claimflow.test');
  await page.goto(`${WEB}/claims/${id}`);
  await page.getByRole('heading', { name: 'Detail trip' }).waitFor();
  assert.equal(await page.getByText('Over limit').count(), 1);
  await page.getByRole('button', { name: 'Submit' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 1);
  for (const b of await page.locator('button, a.button').all()) {
    const box = (await b.boundingBox())!;
    assert.ok(box.width >= 44 && box.height >= 44, 'tap target >= 44px');
  }
  await clean(page, '/claims/:id', true);

  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('button', { name: 'Withdraw' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Submit' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Edit' }).count(), 0);
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByRole('button', { name: 'Submit' }).waitFor();
  assert.equal(await page.locator('ol.plain li').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0); // has history

  // no manager: Submit disabled with the explanation
  const sm = await signIn('senior.manager@claimflow.test');
  await sm.goto(`${WEB}/claims/${await mk('senior.manager@claimflow.test')}`);
  await sm.getByText('You have no manager, so you cannot submit claims').waitFor();
  assert.ok(await sm.getByRole('button', { name: 'Submit' }).isDisabled());

  // not the claimant: read-only; unknown id
  const fin = await signIn('finance@claimflow.test');
  await fin.goto(`${WEB}/claims/${id}`);
  await fin.getByRole('alert').waitFor();
  assert.match(await fin.getByRole('alert').innerText(), /Access denied/);
  await page.goto(`${WEB}/claims/nope`);
  assert.match(await page.getByRole('alert').innerText(), /Claim not found/);
});
