import { pathToFileURL } from 'node:url';
import { loadDotenv } from './env.js';
import { createPrisma } from './db.js';
import { ConfigError, loadConfig } from './config.js';
import { createMailer } from './mailer.js';
import { prismaClaimStore } from './claims/store.js';
import { receiptStorage } from './claims/receipt-storage.js';
import { createApp } from './app.js';
import { startDispatcher } from './notify/dispatcher.js';
import { createLogger, serializeError, type Logger } from './logger.js';

export function onFatal(log: Logger, e: unknown, exit: (code: number) => unknown = process.exit): void {
  try {
    log.error('fatal', { error: serializeError(e) });
  } finally {
    exit(1);
  }
}

// Only start when run directly, so tests can import onFatal.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotenv();
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`); // stderr, not stdout
      process.exit(1);
    }
    throw e;
  }
  const log = createLogger();
  const receipts = receiptStorage(config.receiptsDir);
  receipts.ensureDir(); // before listen
  process.on('uncaughtException', (e) => onFatal(log, e));
  process.on('unhandledRejection', (e) => onFatal(log, e));
  const prisma = createPrisma(config);
  const mailer = createMailer(config);
  const clock = () => new Date();
  createApp({ testRoutes: process.env.NODE_ENV === 'test', log, deps: { prisma, clock, mailer, publicBaseUrl: config.publicBaseUrl, receipts, claims: prismaClaimStore } }).listen(3001, '127.0.0.1', () => {
    log.info('API listening', { host: '127.0.0.1', port: 3001 });
    startDispatcher({ prisma, clock, mailer, log, publicBaseUrl: config.publicBaseUrl });
  });
}
