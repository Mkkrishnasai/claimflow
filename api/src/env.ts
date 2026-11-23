import dotenv from 'dotenv';

export function loadDotenv(): void {
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env', quiet: true, override: false });
}
