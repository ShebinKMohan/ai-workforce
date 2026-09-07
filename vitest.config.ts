import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Storage and process tests use exclusive temp directories; keep files isolated.
    fileParallelism: true,
  },
});
