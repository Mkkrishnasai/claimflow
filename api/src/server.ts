import { loadDotenv } from './env.js';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

loadDotenv();
try {
  loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`); // stderr, not stdout
    process.exit(1);
  }
  throw e;
}
const log = createLogger();
createApp({ testRoutes: process.env.NODE_ENV === 'test', log }).listen(3001, '127.0.0.1', () =>
  log.info('API listening', { host: '127.0.0.1', port: 3001 }),
);
