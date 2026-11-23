import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMailer } from '../../api/src/mailer.js';

// Minimal SMTP sink: enough protocol for nodemailer to deliver one message.
function sink() {
  const msgs: string[] = [];
  const srv = net.createServer((s) => {
    let data = '', inData = false;
    s.write('220 test\r\n');
    s.on('data', (c) => {
      data += c;
      if (inData) {
        if (!data.endsWith('\r\n.\r\n')) return;
        msgs.push(data); data = ''; inData = false; s.write('250 ok\r\n'); return;
      }
      for (const l of data.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(l)) s.write('250 test\r\n');
        else if (/^DATA/i.test(l)) { s.write('354 go\r\n'); inData = true; }
        else if (/^QUIT/i.test(l)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
      data = '';
    });
  });
  return new Promise<{ port: number; msgs: string[]; close: () => void }>((r) =>
    srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as net.AddressInfo).port, msgs, close: () => srv.close() })));
}

test('linkMail delivers the set-password link over SMTP', async () => {
  const s = await sink();
  await createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('set_password', 'a@b.test', 'http://app.test/set-password#token=abc');
  s.close();
  assert.equal(s.msgs.length, 1);
  assert.match(s.msgs[0], /http:\/\/app\.test\/set-password#token=abc/);
});

test('linkMail rejects when SMTP is unreachable', async () => {
  const s = await sink();
  s.close();
  await assert.rejects(createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('reset', 'a@b.test', 'http://x'));
});

test('linkMail states the 1 hour validity for reset links', async () => {
  const s = await sink();
  await createMailer({ smtp: { host: '127.0.0.1', port: s.port } }).linkMail('reset', 'a@b.test', 'http://app.test/reset-password#token=abc');
  s.close();
  assert.match(s.msgs[0], /within 1 hour/);
});
