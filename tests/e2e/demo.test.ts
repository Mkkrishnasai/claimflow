import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WEB, PW, mailpit, startStack, stopStack, apiAs, tabTo } from './stack.helpers.js';
import { chromium, type Locator, type Page } from '@playwright/test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(startStack);
after(stopStack);

// date inputs: Tab to focus (reachability), then fill ISO (segment typing is locale-dependent)
const today = () => new Date().toISOString().slice(0, 10);
const date = async (page: Page, sel: string, label: string) => { await tabTo(page, sel, 80, label); await page.locator(sel).fill(today()); };
// Focus `sel` by Tab (fails with the step label), then press `key`.
const key = async (page: Page, sel: string | Locator, label: string, k = 'Enter') => { await tabTo(page, sel, 80, label); await page.keyboard.press(k); };
const type = async (page: Page, sel: string, label: string, text: string) => { await tabTo(page, sel, 80, label); await page.keyboard.type(text); };

test('demo: submit with receipt, approve, pay, emails and history', { timeout: 180_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const ctx = async (email: string) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(WEB + '/sign-in');
      await type(page, '#email', `${email} email`, email);
      await type(page, '#password', `${email} password`, PW);
      await key(page, 'button[type=submit]', `${email} sign in`);
      await page.waitForURL((u) => u.pathname !== '/sign-in', { waitUntil: 'commit' });
      return page;
    };
    const status = async (who: string, id: string) => {
      const s = await apiAs(`${who}@claimflow.test`, PW);
      return (await (await fetch(`${WEB}/api/claims/${id}`, { headers: { cookie: s.cookie } })).json()) as { status: string; approver?: { email: string }; history: { seq: number; action: string }[] };
    };

    // AC-1: seed only, no claims
    const emp0 = await apiAs('employee@claimflow.test', PW);
    assert.deepEqual(await (await fetch(`${WEB}/api/claims`, { headers: { cookie: emp0.cookie } })).json(), [], 'start state: no claims');
    const admin = await apiAs('admin@claimflow.test', PW);
    const users = (await (await fetch(`${WEB}/api/users`, { headers: { cookie: admin.cookie } })).json()) as { email: string }[];
    for (const e of ['employee', 'manager', 'senior.manager', 'finance', 'admin']) assert.ok(users.some((u) => u.email === `${e}@claimflow.test`), `seed user ${e}`);

    // AC-2: employee, keyboard only
    const emp = await ctx('employee@claimflow.test');
    await emp.goto(WEB + '/claims/new');
    await emp.getByRole('heading', { name: 'New claim' }).waitFor();
    await type(emp, '#title', 'employee title', 'Demo trip');
    await type(emp, '#purpose', 'employee purpose', 'Client visit Berlin');
    await date(emp, 'input[id^=date-]', 'employee date');
    await type(emp, 'input[id^=amt-]', 'employee amount', '120.00');
    await type(emp, 'input[id^=desc-]', 'employee description', 'Train');
    await key(emp, 'button[type=submit]', 'employee save claim');
    await emp.waitForURL(/\/claims\/[^/]+\/edit$/, { waitUntil: 'commit' });
    const id = emp.url().split('/')[4];
    await emp.locator('input[type=file][accept^="image/jpeg"]').waitFor({ state: 'attached' });
    // R-3: Space on the file input should raise a filechooser; setFiles on that chooser attaches the PNG.
    await tabTo(emp, 'input[type=file][accept^="image/jpeg"]', 80, 'employee choose file');
    const chooser = emp.waitForEvent('filechooser');
    await emp.keyboard.press('Space');
    await (await chooser).setFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await emp.getByText('receipt.png').waitFor();
    await emp.goto(`${WEB}/claims/${id}`);
    await key(emp, emp.getByRole('button', { name: 'Submit', exact: true }), 'employee submit');
    await emp.getByRole('button', { name: 'Withdraw' }).waitFor();
    const sub = await status('employee', id);
    assert.equal(sub.status, 'submitted', 'employee: status submitted');

    // AC-3: manager approves
    const mgr = await ctx('manager@claimflow.test');
    await mgr.goto(WEB + '/approvals');
    await mgr.getByRole('heading', { name: 'Demo trip' }).waitFor();
    assert.equal(await mgr.getByRole('link', { name: /^Receipt/ }).count(), 1, 'manager: receipt link');
    await mgr.goto(`${WEB}/approvals/${id}`);
    await key(mgr, mgr.getByRole('button', { name: 'Approve', exact: true }), 'manager approve');
    await mgr.waitForResponse((r) => r.url().includes('/approve') && r.ok());
    assert.equal((await status('manager', id)).status, 'ready_to_pay', 'manager: ready_to_pay');
    const approvedAt = performance.now();

    // finance pays
    const fin = await ctx('finance@claimflow.test');
    await fin.goto(WEB + '/payments');
    await fin.getByRole('link', { name: 'Demo trip' }).click();
    await date(fin, '#pay-date', 'finance date');
    await type(fin, '#pay-ref', 'finance reference', 'REF-DEMO-1');
    await key(fin, fin.getByRole('button', { name: 'Mark paid', exact: true }), 'finance mark paid');
    await fin.waitForResponse((r) => r.url().includes('/pay') && r.ok());
    assert.equal((await status('finance', id)).status, 'paid', 'finance: paid');

    // AC-4: emails within 90 s of the action (bounded polling)
    const want = ['Your claim was approved', 'Your claim was paid'];
    const got = new Set<string>();
    while (got.size < want.length && performance.now() - approvedAt < 90_000) {
      const l = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: { Subject: string; To: { Address: string }[] }[] };
      for (const m of l.messages) if (m.To.some((t) => t.Address === 'employee@claimflow.test')) got.add(m.Subject);
      if (got.size < want.length) await new Promise((r) => setTimeout(r, 1000));
    }
    for (const s of want) assert.ok(got.has(s), `mail ${s} not received`);

    // AC-5: history, API and UI
    const done = await status('employee', id);
    assert.deepEqual(done.history.map((h) => [h.seq, h.action]), [[1, 'submit'], [2, 'approve_final'], [3, 'pay']]);
    await emp.goto(`${WEB}/claims/${id}`);
    const hist = emp.locator('h2:text-is("History") + ol li');
    await hist.first().waitFor();
    const items = await hist.allInnerTexts();
    assert.equal(items.length, 3, 'UI history entries');
    const names = ['Employee', 'Manager', 'Finance'];
    items.forEach((t, i) => { assert.match(t, new RegExp(`^.*${names[i]}.*: ${['Submitted', 'Approved', 'Paid'][i]} .* on .+\\d`, 'i'), `history entry ${i + 1}`); });
  } finally { await browser.close(); }
});
