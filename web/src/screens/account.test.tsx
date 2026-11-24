import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ForgotPassword from './ForgotPassword';
import SetPassword from './SetPassword';
import SignIn from './SignIn';

const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf8');
globalThis.location = { search: '', hash: '' } as Location;

describe('account screens (C-53)', () => {
  it.each([
    ['SignIn', <SignIn onSignedIn={() => {}} />, ['email', 'password']],
    ['SetPassword', <SetPassword go={() => {}} />, ['password']],
    ['ForgotPassword', <ForgotPassword />, ['email']],
  ])('%s: split aside + card, labelled ids kept, no error markup before submit', (_n, el, ids) => {
    const out = html(el);
    expect(out).toContain('class="auth"');
    expect(out).toContain('auth__aside');
    expect(out).toContain('class="card"');
    expect(out).toMatch(/novalidate/i);
    for (const id of ids) expect(out).toContain(`<label for="${id}">`);
    expect(out).not.toContain('aria-invalid');
  });
  it('aside is hidden by default and shown only from 768px', () => {
    expect(css).toMatch(/\.auth__aside \{ display: none; \}/);
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*main\.auth \{ grid-template-columns: 1fr 1fr; \}\s*\.auth__aside \{ display: flex;/);
  });
});
