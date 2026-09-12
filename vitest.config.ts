import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.test.js`: the office UI's own tests (tests/office), plain JavaScript
    // like the vendored modules they import from web/office/src.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Storage and process tests use exclusive temp directories; keep files isolated.
    fileParallelism: true,
  },
});
