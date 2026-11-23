import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../api/src/app.js';
import { createLogger } from '../../api/src/logger.js';

test('sid cookie carries Secure; HttpOnly; SameSite=Lax over HTTPS via a TLS proxy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } } });
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.create({ data: { email: 'admin@claimflow.test', name: 'Admin', role: 'admin', passwordHash: await bcrypt.hash('correct horse battery', 12) } });
  const api = createApp({ log: createLogger({ write: () => true }), deps: { prisma, clock: () => new Date() } }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  const apiPort = (api.address() as AddressInfo).port;
  const proxy = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => proxy.once('listening', r));
  const port = (proxy.address() as AddressInfo).port;
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<http.IncomingMessage & { body: string }>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(Object.assign(res, { body: b })));
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    const pre = await call('GET', '/api/auth/csrf');
    const token = JSON.parse(pre.body).csrfToken as string;
    const r = await call('POST', '/api/auth/sign-in',
      { 'content-type': 'application/json', 'x-csrf-token': token, cookie: `csrf_pre=${token}` },
      JSON.stringify({ email: 'admin@claimflow.test', password: 'correct horse battery' }));
    assert.equal(r.statusCode, 200);
    const sid = r.headers['set-cookie']!.find((c) => c.startsWith('sid='))!;
    assert.match(sid, /;\s*Secure/);
    assert.match(sid, /;\s*HttpOnly/);
    assert.match(sid, /;\s*SameSite=Lax/);
  } finally {
    proxy.close();
    api.close();
    await prisma.$disconnect();
  }
});
