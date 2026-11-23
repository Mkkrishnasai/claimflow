import express, { type Express } from 'express';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFound, requestLog } from './middleware.js';
import { testRouter } from './test-routes.js';

export interface AppOptions {
  testRoutes?: boolean;
  log?: Logger;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.use(requestLog(opts.log ?? createLogger()));
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  if (opts.testRoutes) app.use(testRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
