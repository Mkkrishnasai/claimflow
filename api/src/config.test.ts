import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from './config.js';

const ok = { DATABASE_URL: 'file:./x.db', SMTP_HOST: 'h', SMTP_PORT: '1025' };

for (const k of Object.keys(ok)) {
  for (const bad of [undefined, '']) {
    test(`${k}=${JSON.stringify(bad)} is rejected`, () => {
      const env = { ...ok, [k]: bad } as NodeJS.ProcessEnv;
      assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && e.variable === k);
    });
  }
}

test('invalid SMTP_PORT names SMTP_PORT', () => {
  for (const p of ['abc', '0', '70000', '1.5']) {
    assert.throws(() => loadConfig({ ...ok, SMTP_PORT: p }), (e) => e instanceof ConfigError && e.variable === 'SMTP_PORT');
  }
});

test('SMTP creds optional, frozen config', () => {
  const c = loadConfig(ok);
  assert.equal(c.smtp.user, undefined);
  assert.equal(c.smtp.port, 1025);
  assert.ok(Object.isFrozen(c));
  assert.equal(loadConfig({ ...ok, SMTP_USER: 'u', SMTP_PASS: 'p' }).smtp.user, 'u');
});
