import { loadDotenv } from './env.js';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './app.js';

loadDotenv();
try {
  loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
createApp().listen(3001, '127.0.0.1', () => console.log('API listening on 127.0.0.1:3001'));
