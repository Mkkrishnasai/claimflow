import { pathToFileURL } from 'node:url';
import { loadDotenv } from './env.js';
import { createPrisma } from './db.js';
import { ConfigError, loadConfig } from './config.js';
import { createMailer } from './mailer.js';
import { createApp } from './app.js';
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
  process.on('uncaughtException', (e) => onFatal(log, e));
  process.on('unhandledRejection', (e) => onFatal(log, e));
  createApp({ testRoutes: process.env.NODE_ENV === 'test', log, deps: { prisma: createPrisma(config), clock: () => new Date(), mailer: createMailer(config), publicBaseUrl: config.publicBaseUrl } }).listen(3001, '127.0.0.1', () =>
    log.info('API listening', { host: '127.0.0.1', port: 3001 }),
  );
}
