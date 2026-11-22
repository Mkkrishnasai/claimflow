import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api/src/*.test.ts', 'prisma/*.test.ts', 'scripts/*.test.mjs'],
    testTimeout: 60_000, // seed tests spawn prisma/tsx subprocesses
    hookTimeout: 60_000,
  },
});
