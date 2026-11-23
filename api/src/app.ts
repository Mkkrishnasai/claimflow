import express, { Router, type Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Clock } from './db.js';
import { authRoutes } from './auth/routes.js';
import { authenticate } from './auth/session.js';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFound, requestLog } from './middleware.js';
import { testRouter } from './test-routes.js';

export interface AppOptions {
  testRoutes?: boolean;
  log?: Logger;
  deps?: { prisma: PrismaClient; clock: Clock };
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.use(requestLog(opts.log ?? createLogger()));
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  if (opts.deps) {
    const { prisma, clock } = opts.deps;
    const api = Router();
    api.use(authenticate(prisma, clock), express.json({ limit: '10kb' }), authRoutes(prisma, clock));
    app.use('/api', api);
  }
  if (opts.testRoutes) app.use(testRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
