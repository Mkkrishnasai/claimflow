import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Alert, Button, DateField, EmptyState, FlagBadge, PageHeader, Select, StatusBadge, Table, TextField } from './components';

const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf8');
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('badges', () => {
  it('StatusBadge shows the label, never the raw value', () => {
    const out = html(<StatusBadge status="ready_to_pay" />);
    expect(out).toContain('>Ready to pay<');
    expect(out).not.toContain('ready_to_pay');
    expect(() => html(<StatusBadge status="bogus" />)).toThrow();
  });
  it('FlagBadge renders its text', () => expect(html(<FlagBadge>Over limit</FlagBadge>)).toContain('Over limit'));
});

describe('form DOM contract', () => {
  it.each([
    ['TextField', (e?: string) => <TextField id="a" label="Amount" error={e} />],
    ['Select', (e?: string) => <Select id="a" label="Amount" error={e}><option>x</option></Select>],
    ['DateField', (e?: string) => <DateField id="a" label="Amount" error={e} />],
  ])('%s: one label for the id; aria only with error', (_n, make) => {
    const ok = html(make());
    expect(count(ok, /<label /g)).toBe(1);
    expect(ok).toContain('<label for="a">');
    expect(ok).not.toContain('aria-invalid');
    expect(ok).not.toContain('aria-describedby');
    const bad = html(make('Required'));
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain('aria-describedby="a-err"');
    expect(bad).toContain('id="a-err"');
    expect(bad).toContain('Required');
  });
  it('joins hint and custom error ids, passes native props', () => {
    const out = html(<TextField id="a" label="L" multiline hint={{ id: 'h', text: 'hint' }} error="bad" errorId="e1" disabled />);
    expect(out).toContain('aria-describedby="h e1"');
    expect(out).toContain('<textarea');
    expect(out).toContain('disabled');
  });
  it('PageHeader h1 is focusable unless opted out; Alert has role', () => {
    expect(html(<PageHeader title="T" />)).toContain('<h1 tabindex="-1">T</h1>');
    expect(html(<PageHeader title="T" focusable={false} />)).not.toContain('tabindex');
    expect(html(<Alert>oops</Alert>)).toContain('role="alert"');
    expect(html(<Alert role="status" tone="info">ok</Alert>)).toContain('role="status"');
    expect(html(<EmptyState text="No claims yet" />)).toContain('No claims yet');
  });
});

describe('Button', () => {
  it('forwards native props; defaults type=button', () => {
    const out = html(<Button id="go" variant="danger" disabled aria-label="Go">Remove</Button>);
    expect(out).toMatch(/<button[^>]*id="go"/);
    expect(out).toContain('type="button"');
    expect(out).toContain('disabled');
    expect(out).toContain('aria-label="Go"');
    expect(out).toContain('btn--danger');
    expect(html(<Button type="submit">S</Button>)).toContain('type="submit"');
  });
  it('anchor form keeps class button', () => {
    expect(html(<Button href="/claims/new" variant="secondary">New</Button>)).toMatch(/<a [^>]*class="button btn btn--secondary"/);
  });
  it('CSS keeps 44px targets and a --primary focus ring', () => {
    expect(css).toMatch(/button \{[^}]*min-height: var\(--target\);[^}]*min-width: var\(--target\)/);
    expect(css).toMatch(/a\.button[^{]*\{[^}]*min-height: var\(--target\)/);
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--primary\)/);
    expect(css).toMatch(/--target: 44px/.test(readFileSync(join(__dirname, '..', 'styles', 'tokens.css'), 'utf8')) ? /./ : /$^/);
  });
  it('CSS disables motion under reduced-motion', () => expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*transition: none/));
});

describe('Table', () => {
  const cols = [
    { key: 't', header: 'Title', cell: (r: { t: string; n: number }) => <a href="#">{r.t}</a>, primary: true },
    { key: 'n', header: 'Total', cell: (r: { t: string; n: number }) => r.n, numeric: true },
  ];
  const rows = [{ t: 'Taxi', n: 5 }];
  it('>= 768px renders table with num cells', () => {
    const out = html(<Table columns={cols} rows={rows} rowKey={(r) => r.t} wide />);
    expect(out).toContain('<table class="table"');
    expect(out).toContain('<td class="num">5</td>');
  });
  it('< 768px renders ul.cards > li with h2 and dl', () => {
    const out = html(<Table columns={cols} rows={rows} rowKey={(r) => r.t} wide={false} />);
    expect(out).toMatch(/<ul class="cards"[^>]*><li><h2><a href="#">Taxi<\/a><\/h2><dl><dt>Total<\/dt><dd class="num">5<\/dd><\/dl><\/li>/);
    expect(out).not.toContain('<table');
  });
  it('defaults to the table when matchMedia is unavailable (server snapshot)', () => {
    expect(html(<Table columns={cols} rows={rows} rowKey={(r) => r.t} />)).toContain('<table');
  });
});
