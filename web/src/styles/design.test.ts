import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..');
const read = (p: string) => readFileSync(p, 'utf8');
const tokens = read(join(__dirname, 'tokens.css'));
const app = read(join(src, 'app.css'));

// Expected values copied from the epic Reference Tables (CLAIM-79). Amend here only with the epic.
const THEME: Record<string, [string, string]> = {
  bg: ['#F7F7FB', '#0B1026'], surface: ['#FFFFFF', '#151A36'], border: ['#E4E5EE', '#2A3052'],
  text: ['#0B1026', '#E8E9F5'], 'text-2': ['#4B5070', '#A9ADC8'], muted: ['#6B7090', '#8A8FB0'],
  primary: ['#6D28D9', '#7C3AED'], 'primary-hover': ['#5B21B6', '#6D28D9'], 'primary-soft': ['#EDE9FE', '#2E1F5E'],
  accent: ['#0F766E', '#2DD4BF'], danger: ['#B91C1C', '#F87171'], warning: ['#B45309', '#FBBF24'], topbar: ['#0B1026', '#070A1A'],
};
const BADGES: Record<string, [string, string, string, string]> = { // light fg, light bg, dark fg, dark bg
  draft: ['#475569', '#F1F5F9', '#CBD5E1', '#1E293B'], submitted: ['#1D4ED8', '#DBEAFE', '#93C5FD', '#1E3A8A'],
  approved: ['#6D28D9', '#EDE9FE', '#C4B5FD', '#2E1F5E'], rejected: ['#B91C1C', '#FEE2E2', '#FCA5A5', '#7F1D1D'],
  ready: ['#0F766E', '#CCFBF1', '#5EEAD4', '#134E4A'], paid: ['#15803D', '#DCFCE7', '#86EFAC', '#14532D'],
  flag: ['#B45309', '#FEF3C7', '#FCD34D', '#78350F'],
};
const EXPECTED: [Record<string, string>, Record<string, string>] = [{}, {}];
for (const [k, [l, d]] of Object.entries(THEME)) { EXPECTED[0][k] = l; EXPECTED[1][k] = d; }
for (const [k, [lf, lb, df, db]] of Object.entries(BADGES)) {
  EXPECTED[0][`badge-${k}-fg`] = lf; EXPECTED[0][`badge-${k}-bg`] = lb;
  EXPECTED[1][`badge-${k}-fg`] = df; EXPECTED[1][`badge-${k}-bg`] = db;
}

const darkAt = tokens.indexOf('@media (prefers-color-scheme: dark)');
const decls = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const light = decls(tokens.slice(0, darkAt));
const dark = { ...light, ...decls(tokens.slice(darkAt)) };
const themes = [light, dark];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const webFiles = files(src);

describe('AC-1 token values', () => {
  it('has a dark block', () => expect(darkAt).toBeGreaterThan(0));
  for (const [i, name] of ['light', 'dark'].entries()) {
    it(`27/27 tokens match the epic in ${name}`, () => {
      expect(Object.keys(EXPECTED[i])).toHaveLength(27);
      for (const [k, v] of Object.entries(EXPECTED[i])) expect(themes[i][k]?.toUpperCase(), `--${k}`).toBe(v);
    });
  }
  it('dark block defines every colour token itself (no silent light fallback)', () => {
    const d = decls(tokens.slice(darkAt));
    for (const k of Object.keys(EXPECTED[1])) expect(d[k], `--${k}`).toBeDefined();
  });
});

describe('AC-2 no hex outside tokens.css', () => {
  it('only tokens.css contains hex colours', () => {
    const hits = webFiles.filter((f) => /#[0-9A-Fa-f]{3,8}\b/.test(read(f)) && !f.endsWith('tokens.css') && !f.endsWith('design.test.ts'));
    expect(hits).toEqual([]);
  });
});

describe('AC-3 shape tokens', () => {
  it('tokens carry radius, shadow, grid, padding', () => {
    expect([light['radius-card'], light['radius-input'], light['radius-btn'], light['radius-pill']]).toEqual(['12px', '12px', '8px', '999px']);
    expect(light['shadow-card']).toContain('rgba(11, 16, 38, .06)');
    expect([light['space-1'], light['space-3']]).toEqual(['8px', '24px']);
  });
  it('app.css has no literal px/rem for radius, shadow, padding, margin', () => {
    const bad = [...app.matchAll(/(border-radius|box-shadow|padding[\w-]*|margin[\w-]*)\s*:\s*([^;}]+)/g)]
      .filter((m) => /\d+(\.\d+)?(px|rem|em)\b/.test(m[2]));
    expect(bad.map((m) => m[0])).toEqual([]);
  });
});

describe('AC-4 reset and fonts', () => {
  const main = read(join(src, 'main.tsx'));
  it('main.tsx imports reset, tokens, app.css in order', () => {
    const imports = [...main.matchAll(/import '(\.\/[^']+\.css)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./styles/reset.css', './styles/tokens.css', './app.css']);
  });
  it('exactly one reset stylesheet', () => {
    expect(webFiles.filter((f) => /reset[^/]*\.css$/i.test(f))).toHaveLength(1);
  });
  it('fonts <= 100 KB, no npm font package, no third-party url()', () => {
    const dir = join(src, '..', 'public', 'fonts');
    const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(100 * 1024);
    const pkg = JSON.parse(read(join(src, '..', '..', 'package.json')));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((n) => /font|inter/i.test(n))).toEqual([]);
    for (const f of webFiles.filter((f) => f.endsWith('.css'))) expect(read(f)).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
  });
});

describe('AC-5 contrast and brand allow-list', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // architecture 8.1 pair list: [fg, bg, min]
  const PAIRS: [string, string, number][] = [];
  for (const fg of ['text', 'text-2', 'muted', 'danger', 'warning', 'primary']) for (const bg of ['bg', 'surface']) PAIRS.push([fg, bg, 4.5]);
  PAIRS.push(['on-primary', 'primary', 4.5], ['on-primary', 'primary-hover', 4.5], ['text', 'primary-soft', 4.5], ['topbar-text', 'topbar', 4.5]);
  for (const b of Object.keys(BADGES)) PAIRS.push([`badge-${b}-fg`, `badge-${b}-bg`, 4.5]);
  PAIRS.push(['primary', 'bg', 3], ['primary', 'surface', 3], ['primary', 'topbar', 3], ['muted', 'surface', 3]);
  // Spec Open Question 1: dark --primary as link text / focus ring is below AA. Tracked, not hidden: remove when decided.
  // Also light --primary ring on --topbar (2.9:1): the topbar (S3) must draw its ring with --topbar-text.
  const OPEN_Q1 = new Set(['dark:primary/bg/4.5', 'dark:primary/surface/4.5', 'dark:primary/surface/3', 'light:primary/topbar/3']);

  for (const [i, name] of ['light', 'dark'].entries()) {
    it(`0 pairs below threshold in ${name} (except Q-1)`, () => {
      const t = themes[i];
      const resolve = (k: string) => (t[k].startsWith('var(') ? t[t[k].slice(6, -1)] : t[k]);
      const fails = PAIRS.filter(([f, b, min]) => !OPEN_Q1.has(`${name}:${f}/${b}/${min}`) && ratio(resolve(f), resolve(b)) < min)
        .map(([f, b]) => `${name} ${f}/${b}`);
      expect(fails).toEqual([]);
    });
  }
  it('Q-1 exclusions are still real failures (delete the entry when fixed)', () => {
    for (const k of OPEN_Q1) {
      const [, th, f, b, min] = k.match(/^(light|dark):([\w-]+)\/([\w-]+)\/([\d.]+)$/)!;
      const t = th === 'dark' ? dark : light;
      expect(ratio(t[f], t[b])).toBeLessThan(Number(min));
    }
  });

  it('brand tokens only in allow-listed selectors', () => {
    const ALLOWED = /^(button|button:hover|a|a:hover|a\.button:hover, label\.button:hover|a\.button, label\.button, button\.button|label\.button:focus-within|:focus-visible|nav a\[aria-current='page'\])$/;
    const rules = [...app.matchAll(/([^{}@]+)\{([^}]*)\}/g)];
    const bad = rules.filter(([, sel, body]) => /var\(--(primary|accent)/.test(body) && !ALLOWED.test(sel.trim())).map((m) => m[1].trim());
    expect(bad).toEqual([]);
    for (const f of webFiles.filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('app.css') && !f.endsWith('design.test.ts')))
      expect(read(f), f).not.toMatch(/var\(--(primary|accent)/);
  });
});
