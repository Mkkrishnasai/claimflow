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
export const page = async ({ width, scheme }: { width: number; scheme: 'light' | 'dark' }) =>
  (await browser.newContext({ viewport: { width, height: width < 600 ? 740 : 800 }, colorScheme: scheme })).newPage();
export const phone = () => page({ width: 360, scheme: 'light' });
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

// CLAIM-9-S3: every route; ponytail: ROUTES is the single list, App.tsx paths are scanned against it in a11y.test.ts.
export const ROUTES = ['/sign-in', '/set-password', '/reset-password', '/forgot-password', '/claims', '/claims/new', '/claims/:id/edit', '/claims/:id', '/approvals', '/approvals/:id', '/payments', '/payments/:id', '/policy', '/export', '/users', '/users/:id', '/no-such-page'];

// Seeds claims, signs in one browser page per role, then opens every ROUTES entry as the role that may view it and calls cb.
export async function visitRoutes(cb: (page: Page, route: string) => Promise<void>, opts: { width: number; scheme: 'light' | 'dark' } = { width: 360, scheme: 'light' }) {
  const today = new Date().toISOString().slice(0, 10);
  const login = async (who: string) => { const s = await apiAs(`${who}@claimflow.test`, PW); return { s, h: { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie } }; };
  const emp = await login('employee');
  const mgr = await login('manager');
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: emp.s.cookie } })).json()) as { code: string }[])[0];
  const mk = async (step: 'draft' | 'submit' | 'approve') => {
    const body = { title: 'Sweep trip', purpose: 'Client workshop in Berlin', lines: [{ date: today, categoryCode: cat.code, amountCents: 100, description: 'Taxi' }] };
    const id = ((await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: emp.h, body: JSON.stringify(body) })).json()) as { id: string }).id;
    if (step !== 'draft') assert.equal((await fetch(`${WEB}/api/claims/${id}/submit`, { method: 'POST', headers: emp.h })).status, 200);
    if (step === 'approve') assert.equal((await fetch(`${WEB}/api/claims/${id}/approve`, { method: 'POST', headers: mgr.h })).status, 200);
    return id;
  };
  const claimIds = { draft: await mk('draft'), submitted: await mk('submit'), approved: await mk('approve') };
  const admin = await login('admin');
  const adminId = ((await (await fetch(`${WEB}/api/users`, { headers: { cookie: admin.s.cookie } })).json()) as { id: string; role: string }[]).find((u) => u.role === 'admin')!.id;
  // role that can view each route; auth pages and not-found need no session
  const role = (r: string) => (/^\/(sign-in|set-password|reset-password|forgot-password)$/.test(r) ? null
    : r.startsWith('/users') ? 'admin' : r.startsWith('/payments') || r === '/policy' || r === '/export' ? 'finance' : r.startsWith('/approvals') ? 'manager' : 'employee');
  const pages: Record<string, Page> = { none: await page(opts) };
  for (const r of ['admin', 'finance', 'manager', 'employee']) {
    const p = (pages[r] = await page(opts));
    await p.goto(WEB + '/sign-in');
    await p.fill('#email', `${r}@claimflow.test`);
    await p.fill('#password', PW);
    await p.press('#password', 'Enter');
    await p.getByRole('heading').first().waitFor();
  }
  for (const route of ROUTES) {
    const p = pages[role(route) ?? 'none'];
    const id = route.startsWith('/users') ? adminId : route.startsWith('/payments') ? claimIds.approved : route.startsWith('/approvals') ? claimIds.submitted : claimIds.draft;
    const hash = route === '/set-password' || route === '/reset-password' ? '#token=x' : '';
    await p.goto(WEB + route.replace(':id', id) + hash);
    await p.locator('h1, form, [role=alert]').first().waitFor();
    await p.waitForLoadState('networkidle');
    if (route === '/no-such-page') await p.getByRole('alert').first().waitFor();
    await cb(p, route);
  }
  for (const p of Object.values(pages)) await p.context().close();
}
