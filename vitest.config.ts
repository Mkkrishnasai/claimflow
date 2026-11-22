import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api/src/*.test.ts', 'prisma/*.test.ts', 'scripts/*.test.mjs'],
    fileParallelism: false, // tests bind fixed ports 5173/3001/1025/8025; files must run serially
    testTimeout: 60_000, // seed tests spawn prisma/tsx subprocesses
    hookTimeout: 60_000,
  },
});
