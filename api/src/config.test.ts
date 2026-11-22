import { test, expect } from 'vitest';
import { loadConfig, ConfigError } from './config.js';

const expectConfigError = (env: NodeJS.ProcessEnv, variable: string) =>
  expect(() => loadConfig(env)).toThrow(expect.objectContaining({ name: 'ConfigError', variable }));

const ok = { DATABASE_URL: 'file:./x.db', SMTP_HOST: 'h', SMTP_PORT: '1025' };

for (const k of Object.keys(ok)) {
  for (const bad of [undefined, '']) {
    test(`${k}=${JSON.stringify(bad)} is rejected`, () => {
      const env = { ...ok, [k]: bad } as NodeJS.ProcessEnv;
      expectConfigError(env, k);
    });
  }
}

test('invalid SMTP_PORT names SMTP_PORT', () => {
  for (const p of ['abc', '0', '70000', '1.5']) {
    expectConfigError({ ...ok, SMTP_PORT: p }, 'SMTP_PORT');
  }
});

test('SMTP creds optional, frozen config', () => {
  const c = loadConfig(ok);
  expect(c.smtp.user).toBe(undefined);
  expect(c.smtp.port).toBe(1025);
  expect(Object.isFrozen(c)).toBeTruthy();
  expect(loadConfig({ ...ok, SMTP_USER: 'u', SMTP_PASS: 'p' }).smtp.user).toBe('u');
});
