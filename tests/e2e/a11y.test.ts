import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEB, PW, NEW_PW, startStack, stopStack, apiAs, mailLink, phone, clean, ROUTES, visitRoutes } from './stack.helpers.js';

const openMenu = async (page: import('@playwright/test').Page) => {
  const b = page.getByRole('button', { name: 'Menu' });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
};

before(startStack);
after(stopStack);

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
  await clean(page, '/claims');
  assert.equal(await page.getByRole('link', { name: 'My account' }).count(), 1);

  await page.getByRole('link', { name: 'New claim' }).click();
  await page.getByRole('heading', { name: 'New claim' }).waitFor();
  await page.locator('label[for=title]:visible').waitFor();
  for (const id of await page.locator('input:not([type=file]), select, textarea').evaluateAll((els) => els.map((e) => e.id))) {
    assert.equal(await page.locator(`label[for="${id}"]:visible`).count(), 1, `label for #${id}`);
  }
  await clean(page, '/claims/new');
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
  await clean(page, '/claims/:id/edit');

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
    const today = new Date().toISOString().slice(0, 10);
    const line = (amountCents: number) => ({ date: today, categoryCode: cat.code, amountCents, description: 'Taxi', justification: 'Client dinner with the whole team' });
    const r = await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Detail trip', purpose: 'Client workshop in Berlin', lines: [line(100), line(cat.limitCents + 1)] }) });
    const claim = (await r.json()) as { id: string; lines: { id: string }[] };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await fetch(`${WEB}/api/claims/${claim.id}/lines/${claim.lines[1].id}/receipts`, { method: 'POST', headers: { 'x-csrf-token': s.csrf, cookie: s.cookie, 'x-filename': 'r.png', 'content-type': 'image/png' }, body: png });
    return claim.id;
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
  await clean(page, '/claims/:id');

  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('button', { name: 'Withdraw' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Submit' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Edit' }).count(), 0);
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByRole('button', { name: 'Submit' }).waitFor();
  assert.equal(await page.locator('ol.plain li').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0); // has history
  // withdrawn: Draft badge, readable timeline, no raw status/action values
  assert.equal(await page.locator('.badge', { hasText: /^Draft$/ }).count(), 1);
  assert.match(await page.locator('ol.plain li').last().innerText(), /: Withdrawn \(Submitted to Draft\)/);
  assert.doesNotMatch(await page.locator('main, section').first().innerText(), /\b(submitted|ready_to_pay|approve_first|withdraw)\b(?!.*\()/);

  // no manager: Submit disabled with the explanation
  const sm = await signIn('senior.manager@claimflow.test');
  await sm.goto(`${WEB}/claims/${await mk('senior.manager@claimflow.test')}`);
  await sm.getByText('A user with no manager cannot submit claims').waitFor();
  assert.ok(await sm.getByRole('button', { name: 'Submit' }).isDisabled());

  // not the claimant: read-only; unknown id
  const fin = await signIn('finance@claimflow.test');
  await fin.goto(`${WEB}/claims/${id}`);
  await fin.getByRole('alert').waitFor();
  assert.match(await fin.getByRole('alert').innerText(), /Access denied/);
  await page.goto(`${WEB}/claims/nope`);
  assert.match(await page.getByRole('alert').innerText(), /Claim not found/);
});

test('CLAIM-4-S5 failures list, flags and justification field at 360 px', async () => {
  const s = await apiAs('employee@claimflow.test', PW);
  const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string; limitCents: number }[])[0];
  const line = (amountCents: number, date: string) => ({ date, categoryCode: cat.code, amountCents, description: 'Taxi' });
  const mkClaim = async (lines: unknown[]) => ((await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Flag trip', purpose: 'Client workshop in Berlin', lines }) })).json()) as { id: string }).id;
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'employee@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();

  // old date + over limit without receipt/justification: 3 failures on line 1, 1 on line 2
  const bad = await mkClaim([line(Math.max(cat.limitCents + 1, 2500), '2020-01-01'), line(100, '2020-01-01')]);
  await page.goto(`${WEB}/claims/${bad}`);
  await page.getByRole('button', { name: 'Submit' }).click();
  const alert = page.getByRole('alert');
  await alert.getByText('Submit refused: 4 problems').waitFor();
  assert.equal(await alert.locator('li').count(), 4);
  for (const t of await alert.locator('li').allInnerTexts()) assert.match(t, /^(Line \d+|Claim)/);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
  assert.equal(await page.getByText('Draft', { exact: true }).count(), 1);
  await clean(page, 'refused submit');

  // editor: justification field appears above the limit
  await page.goto(`${WEB}/claims/${bad}/edit`);
  await page.locator('textarea[id^=just-]').first().waitFor();
  assert.match(await page.locator('label[for^=just-]').first().innerText(), /^Justification \(at least 20 characters, required above EUR /);
  assert.equal(await page.locator('textarea[id^=just-]').count(), 1); // line 2 is within limit
  assert.match((await page.locator('textarea[id^=just-]').first().getAttribute('class')) ?? '', /attention/); // highlighted while required
  assert.equal(await page.locator('.dropzone').count(), 2); // receipt drop zone per saved line
  await clean(page, 'editor with justification');

  // flags: same date/category/amount on the claimant's other submitted claim
  const today = new Date().toISOString().slice(0, 10);
  const first = await mkClaim([line(100, today)]);
  const second = await mkClaim([line(100, today)]);
  for (const c of [first, second]) assert.equal((await fetch(`${WEB}/api/claims/${c}/submit`, { method: 'POST', headers: h })).status, 200);
  await page.goto(`${WEB}/claims/${second}`);
  await page.getByText('Possible duplicate (same date, category and amount)').waitFor();
  assert.equal(await page.getByRole('link', { name: 'View earlier claim' }).getAttribute('href'), `/claims/${first}`);
  await clean(page, 'detail with flag');
});

const plain0 = (page: import('@playwright/test').Page, id: string) => page.locator('ul.cards > li').filter({ has: page.locator(`a[href="/approvals/${id}"]`) });

test('CLAIM-5-S5 approvals inbox: cards, flags, receipts, nav, a11y at 360 px', async () => {
  const s = await apiAs('employee@claimflow.test', PW);
  const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string; limitCents: number }[])[0];
  const today = new Date().toISOString().slice(0, 10);
  const line = (amountCents: number) => ({ date: today, categoryCode: cat.code, amountCents, description: 'Inbox taxi', justification: 'Client dinner with the whole team' });
  const mk = async (lines: unknown[]) => (await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Inbox trip', purpose: 'Client workshop in Berlin', lines }) })).json()) as { id: string; lines: { id: string }[] };
  const first = await mk([line(137)]);
  const second = await mk([line(137), line(cat.limitCents + 1)]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${WEB}/api/claims/${second.id}/lines/${second.lines[1].id}/receipts`, { method: 'POST', headers: { 'x-csrf-token': s.csrf, cookie: s.cookie, 'x-filename': 'r.png', 'content-type': 'image/png' }, body: png });
  const receipt = ((await up.json()) as { id: string }).id;
  for (const c of [first.id, second.id]) assert.equal((await fetch(`${WEB}/api/claims/${c}/submit`, { method: 'POST', headers: h })).status, 200);

  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'manager@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await openMenu(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Approvals' }).click();
  await page.getByRole('heading', { name: 'Approvals' }).waitFor();
  await page.getByRole('link', { name: 'Inbox trip' }).first().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  const card = page.locator('ul.cards > li').filter({ has: page.locator(`a[href="/approvals/${second.id}"]`) });
  await card.getByText('Over limit (1)').waitFor();
  await card.getByText('Possible duplicate (1)').waitFor();
  await card.getByText('First approval').waitFor();
  await card.getByText('Submitted', { exact: true }).waitFor();
  await plain0(page, first.id).getByText('Submitted', { exact: true }).waitFor();
  await page.locator('.summary').getByText('Waiting', { exact: true }).waitFor();
  assert.match((await page.locator('.summary .num').innerText()).trim(), /^EUR \d+\.\d\d$/);
  await card.getByText('Employee', { exact: true }).waitFor();
  assert.equal(await card.getByRole('link', { name: /^Receipt/ }).getAttribute('href'), `/api/claims/${second.id}/receipts/${receipt}`);
  const plain = page.locator('ul.cards > li').filter({ has: page.locator(`a[href="/approvals/${first.id}"]`) });
  assert.equal(await plain.getByText(/Over limit|Possible duplicate/).count(), 0);
  await clean(page, '/approvals');

  // nav link: managers only
  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  assert.equal(await emp.getByRole('link', { name: 'Approvals' }).count(), 0);
});

test('CLAIM-5-S6 review screen: read-only, reject error focus, approve, a11y at 360 px', async () => {
  const s = await apiAs('employee@claimflow.test', PW);
  const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string; limitCents: number }[])[0];
  const today = new Date().toISOString().slice(0, 10);
  const line = (amountCents: number) => ({ date: today, categoryCode: cat.code, amountCents, description: 'Review taxi', justification: 'Client dinner with the whole team' });
  const made = (await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Review trip', purpose: 'Client workshop in Berlin', lines: [line(cat.limitCents + 1)] }) })).json()) as { id: string; lines: { id: string }[] };
  const id = made.id;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await fetch(`${WEB}/api/claims/${id}/lines/${made.lines[0].id}/receipts`, { method: 'POST', headers: { 'x-csrf-token': s.csrf, cookie: s.cookie, 'x-filename': 'r.png', 'content-type': 'image/png' }, body: png });
  assert.equal((await fetch(`${WEB}/api/claims/${id}/submit`, { method: 'POST', headers: h })).status, 200);

  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'manager@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await page.goto(`${WEB}/approvals/${id}`);
  await page.getByRole('heading', { name: 'Review trip' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await page.getByText('Over limit').first().waitFor();
  await page.getByText('Client dinner with the whole team').waitFor();
  await page.getByRole('link', { name: 'Back to approvals' }).waitFor();
  assert.equal(await page.locator('input, select').count(), 0);
  assert.equal(await page.locator('textarea').count(), 1);

  await page.getByLabel('Reason for rejection').fill('short');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
  await page.getByText('Submitted', { exact: true }).waitFor();
  await clean(page, 'review with flag and error');

  await page.getByLabel('Reason for rejection').fill('Receipt does not match the amount');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByText('Rejected', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 0);

  // the claimant sees no decision controls
  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  await emp.goto(`${WEB}/approvals/${id}`);
  await emp.getByRole('heading', { name: 'Review trip' }).waitFor();
  assert.equal(await emp.getByRole('button', { name: /Approve|Reject/ }).count(), 0);
});

test('CLAIM-6-S6 payments queue: cards, flags, nav, a11y at 360 px', async () => {
  const s = await apiAs('employee@claimflow.test', PW);
  const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string; limitCents: number }[])[0];
  const date = new Date().toISOString().slice(0, 10); // within the submit-age limit
  const line = (amountCents: number) => ({ date, categoryCode: cat.code, amountCents, description: 'Queue taxi', justification: 'Client dinner with the whole team' });
  const mk = async () => ((await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Queue trip', purpose: 'Client workshop in Berlin', lines: [line(191)] }) })).json()) as { id: string }).id;
  const first = await mk();
  const second = await mk(); // same date, category, amount: flagged as duplicate
  const m = await apiAs('manager@claimflow.test', PW);
  const mh = { 'content-type': 'application/json', 'x-csrf-token': m.csrf, cookie: m.cookie };
  for (const c of [first, second]) {
    assert.equal((await fetch(`${WEB}/api/claims/${c}/submit`, { method: 'POST', headers: h })).status, 200);
    assert.equal((await fetch(`${WEB}/api/claims/${c}/approve`, { method: 'POST', headers: mh })).status, 200);
  }

  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'finance@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await openMenu(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Payments' }).click();
  await page.getByRole('heading', { name: 'Payments', level: 1 }).waitFor();
  await page.getByRole('link', { name: 'Queue trip' }).first().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  const tile = (name: string) => page.locator('dl.summary > div').filter({ has: page.getByText(name, { exact: true }) }).locator('dd');
  assert.match((await tile('Ready to pay').innerText()).trim(), /^\d+$/);
  assert.match((await tile('Total').innerText()).trim(), /^EUR \d+\.\d\d$/);
  const card = page.locator('ul.cards > li').filter({ has: page.locator(`a[href="/payments/${second}"]`) });
  await card.getByText('Possible duplicate (1)').waitFor();
  const plain = page.locator('ul.cards > li').filter({ has: page.locator(`a[href="/payments/${first}"]`) });
  assert.equal(await plain.getByText(/Over limit|Possible duplicate/).count(), 0);
  await clean(page, '/payments');

  // nav link: finance only; others get Access denied
  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  assert.equal(await emp.getByRole('link', { name: 'Payments' }).count(), 0);
  await emp.goto(`${WEB}/payments`);
  await emp.getByRole('alert').getByText('Access denied').waitFor();
});

test('CLAIM-6-S7 payment screen: controls, send-back error focus, pay, own claim, a11y at 360 px', async () => {
  const s = await apiAs('employee@claimflow.test', PW);
  const h = { 'content-type': 'application/json', 'x-csrf-token': s.csrf, cookie: s.cookie };
  const m = await apiAs('manager@claimflow.test', PW);
  const mh = { 'content-type': 'application/json', 'x-csrf-token': m.csrf, cookie: m.cookie };
  const cat = ((await (await fetch(`${WEB}/api/categories`, { headers: { cookie: s.cookie } })).json()) as { code: string }[])[0];
  const today = new Date().toISOString().slice(0, 10);
  const mk = async (n: number) => {
    const body = { title: `Pay trip ${n}`, purpose: 'Client workshop in Berlin', lines: [{ date: today, categoryCode: cat.code, amountCents: 100 + n, description: 'Pay taxi', justification: 'Client dinner with the whole team' }] };
    const id = ((await (await fetch(`${WEB}/api/claims`, { method: 'POST', headers: h, body: JSON.stringify(body) })).json()) as { id: string }).id;
    assert.equal((await fetch(`${WEB}/api/claims/${id}/submit`, { method: 'POST', headers: h })).status, 200);
    assert.equal((await fetch(`${WEB}/api/claims/${id}/approve`, { method: 'POST', headers: mh })).status, 200);
    return id;
  };
  const back = await mk(1);
  const pay = await mk(2);

  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'finance@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await page.goto(`${WEB}/payments/${back}`);
  await page.getByRole('heading', { name: 'Pay trip 1' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await page.getByRole('link', { name: 'Back to payments' }).first().waitFor();
  assert.equal(await page.getByLabel('Payment date').getAttribute('max'), today);
  assert.equal(await page.getByLabel('Payment reference').getAttribute('maxlength'), '100');

  await page.getByLabel('Reason for sending back').fill('short');
  await page.getByRole('button', { name: 'Send back' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert');
  await page.getByText('Ready to pay', { exact: true }).waitFor();
  await clean(page, 'payment screen with error');

  await page.getByLabel('Reason for sending back').fill('Receipt does not match the amount');
  await page.getByRole('button', { name: 'Send back' }).click();
  await page.getByText('Rejected', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark paid' }).count(), 0);

  await page.goto(`${WEB}/payments/${pay}`);
  await page.getByRole('heading', { name: 'Pay trip 2' }).waitFor();
  await page.getByLabel('Payment date').fill(today);
  await page.getByLabel('Payment reference').fill('INV-0042');
  await page.getByRole('button', { name: 'Mark paid' }).dblclick();
  await page.getByText('Paid', { exact: true }).waitFor();
  await page.getByText('INV-0042').waitFor();
  assert.equal(await page.getByRole('button', { name: /Mark paid|Send back/ }).count(), 0);

  // the claimant sees the payment record but no controls
  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  await emp.goto(`${WEB}/claims/${pay}`);
  await emp.getByText('INV-0042').waitFor();
  assert.equal(await emp.getByRole('button', { name: /Mark paid|Send back/ }).count(), 0);
});

test('CLAIM-7-S8 policy screen: load, validate, save once, access, a11y at 360 px', async () => {
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'finance@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await openMenu(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Policy' }).click();
  await page.getByRole('heading', { name: 'Policy settings', level: 1 }).waitFor();
  await page.getByLabel('Meals limit').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  assert.equal(await page.locator('form input').count(), 8);
  assert.equal(await page.getByLabel('Meals limit').inputValue(), '50.00');
  await page.getByText('Changes apply to claims submitted from now on. Claims already submitted keep their current values.').waitFor();
  await clean(page, '/policy');

  await page.getByRole('button', { name: 'Save policy' }).click();
  await page.getByRole('status').getByText('No changes to save').waitFor();
  for (const bad of ['abc', '0', '10000.01']) {
    await page.getByLabel('Meals limit').fill(bad);
    await page.getByRole('button', { name: 'Save policy' }).click();
    await page.locator('#e-' + (await page.getByLabel('Meals limit').getAttribute('id'))!.slice(2)).waitFor();
  }

  let patches = 0;
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/api/policy')) patches++; });
  await page.getByLabel('Meals limit').fill('60');
  await page.getByRole('button', { name: 'Save policy' }).dblclick();
  await page.getByRole('status').getByText('Policy saved').waitFor();
  assert.equal(patches, 1);
  assert.equal(await page.getByLabel('Meals limit').inputValue(), '60.00');

  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  assert.equal(await emp.getByRole('link', { name: 'Policy' }).count(), 0);
  await emp.goto(`${WEB}/policy`);
  await emp.getByRole('alert').getByText('Access denied').waitFor();
  assert.equal(await emp.locator('form').count(), 0);
});

test('CLAIM-7-S9 export screen: download, range validity, failure, access, a11y at 360 px', async () => {
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'finance@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  await openMenu(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Export' }).click();
  await page.getByRole('heading', { name: 'Export paid claims', level: 1 }).waitFor();
  await page.getByLabel('From').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await clean(page, '/export');

  const btn = page.getByRole('button', { name: 'Download CSV' });
  assert.ok(await btn.isDisabled());
  await page.getByLabel('From').fill('2026-03-15');
  assert.ok(await btn.isDisabled());
  await page.getByLabel('To').fill('2026-03-01');
  assert.ok(await btn.isDisabled());
  await page.getByLabel('To').fill('2026-03-15');
  assert.ok(await btn.isEnabled());
  await page.getByLabel('From').fill('2026-03-01');
  const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
  assert.equal(dl.suggestedFilename(), 'paid-claims-2026-03-01-to-2026-03-15.csv');

  await page.route('**/api/exports/paid-claims.csv?*', (r) => r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_input', reason: 'Bad range' }) }));
  await btn.click();
  await page.getByRole('alert').getByText('Bad range').waitFor();
  assert.ok(await btn.isEnabled());

  const emp = await phone();
  await emp.goto(WEB + '/sign-in');
  await emp.fill('#email', 'employee@claimflow.test');
  await emp.fill('#password', PW);
  await emp.press('#password', 'Enter');
  await emp.getByRole('heading', { name: 'My claims' }).waitFor();
  assert.equal(await emp.getByRole('link', { name: 'Export' }).count(), 0);
  await emp.goto(`${WEB}/export`);
  await emp.getByRole('alert').getByText('Access denied').waitFor();
  assert.equal(await emp.locator('form').count(), 0);
});

// CLAIM-9-S3: every route, strict axe, 360 px, one visible label per input.
test('AC-5 every path in App.tsx is in ROUTES', () => {
  const src = readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const found = [...src.matchAll(/path === '([^']+)'|\.match\(\/\^([^$]+)\$\//g)].map((m) => m[1] ?? m[2].replaceAll('\\/', '/').replaceAll('([^/]+)', ':id'));
  assert.ok(found.length >= 16, `only ${found.length} paths scanned`);
  assert.deepEqual(found.filter((p) => !ROUTES.includes(p)), [], 'route in App.tsx missing from ROUTES');
});

test('AC-2/3/4 strict axe, no horizontal scroll and one label per input on every route', () => visitRoutes(async (page, route) => {
  await clean(page, route);
  const bad = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input, select, textarea')]
    .filter((e) => e.type !== 'hidden' && e.getClientRects().length > 0)
    .filter((e) => e.labels?.length !== 1 || ![...e.labels].every((l) => l.getBoundingClientRect().width > 0 && l.getBoundingClientRect().height > 0))
    .map((e) => e.id || e.name));
  assert.deepEqual(bad, [], `${route}: inputs without exactly one visible label`);
}));

test('360px nav disclosure opens with Enter/Space, closes with Escape, and the page does not scroll sideways', async () => {
  const page = await phone();
  await page.goto(WEB + '/sign-in');
  await page.fill('#email', 'manager@claimflow.test');
  await page.fill('#password', PW);
  await page.press('#password', 'Enter');
  await page.getByRole('heading', { name: 'My claims' }).waitFor();
  const btn = page.getByRole('button', { name: 'Menu' });
  const nav = page.getByRole('navigation', { name: 'Main' });
  assert.equal(await btn.getAttribute('aria-expanded'), 'false');
  assert.equal(await nav.getByRole('link', { name: 'Approvals' }).isVisible(), false);
  for (const k of ['Enter', 'Space']) {
    await btn.focus();
    await page.keyboard.press(k);
    assert.equal(await btn.getAttribute('aria-expanded'), 'true', k);
    await nav.getByRole('link', { name: 'Approvals' }).waitFor();
    await nav.getByRole('link', { name: 'Approvals' }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await btn.getAttribute('aria-expanded'), 'false', k);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.close();
});
