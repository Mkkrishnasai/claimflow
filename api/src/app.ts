import express, { Router, type Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from './db.js';
import { authRoutes } from './auth/routes.js';
import { verifyPassword } from './auth/secrets.js';
import { authenticate } from './auth/session.js';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFound, requestLog } from './middleware.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptStorage, type ReceiptStore } from './claims/receipt-storage.js';
import { claimRoutes, receiptUploadRoutes } from './claims/routes.js';
import { userRoutes } from './users/routes.js';
import { policyRoutes } from './policy/routes.js';
import type { ClaimStore } from './claims-port.js';
import type { Mailer } from './mailer.js';
import { claimTestRoutes, testRouter } from './test-routes.js';

export interface AppOptions {
  testRoutes?: boolean;
  log?: Logger;
  deps?: { prisma: PrismaClient; clock: Clock; mailer: Mailer; publicBaseUrl: string; verify?: typeof verifyPassword; claims?: ClaimStore; receipts?: ReceiptStore };
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { // CR-1: on every response, including 404 and errors
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.use(requestLog(opts.log ?? createLogger()));
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  if (opts.deps) {
    const { prisma, clock } = opts.deps;
    const log = opts.log ?? createLogger();
    const api = Router();
    api.use(authenticate(prisma, clock));
    const receipts = opts.deps.receipts ?? receiptStorage(mkdtempSync(join(tmpdir(), 'receipts-'))); // fallback: tests only
    api.use(receiptUploadRoutes({ prisma, clock, receipts })); // raw body: before every JSON parser
    api.use('/claims', express.json({ limit: '100kb' })); // ADR-32: parsed first, so the 10 kb parser below skips it
    api.use(express.json({ limit: '10kb' }), authRoutes(prisma, clock, opts.deps.verify, { mailer: opts.deps.mailer, publicBaseUrl: opts.deps.publicBaseUrl, log }), userRoutes(opts.deps), claimRoutes({ prisma, clock, receipts }), policyRoutes({ prisma, clock, receipts }));
    app.use('/api', api);
  }
  if (opts.testRoutes) {
    app.use(testRouter);
    if (opts.deps) app.use(claimTestRoutes(opts.deps.prisma, opts.deps.clock));
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
