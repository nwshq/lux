import { defineConfig } from 'vitest/config';

// Root Vitest intentionally includes src/** only; this keeps the independently owned benchmark
// security suite focused without broadening the repository's default production test selection.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['benchmarks/corpora/__tests__/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
