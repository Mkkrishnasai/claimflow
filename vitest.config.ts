import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api/**/*.test.ts', 'prisma/**/*.test.ts', 'scripts/**/*.test.mjs', 'web/**/*.test.{ts,tsx}'], // tests/e2e stays on the node:test runner (npm run test:e2e)
    fileParallelism: false, // tests bind fixed ports 5173/3001/1025/8025; files must run serially
    testTimeout: 60_000, // seed tests spawn prisma/tsx subprocesses
    hookTimeout: 60_000,
  },
});
