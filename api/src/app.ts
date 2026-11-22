import express, { type Express } from 'express';

export interface AppOptions {
  testRoutes?: boolean;
  log?: (msg: string) => void;
}

// testRoutes/log are wired in later stories (S3).
export function createApp(_opts: AppOptions = {}): Express {
  const app = express();
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}
