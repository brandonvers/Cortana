import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // spikes/ is throwaway by design and private/ is never published; neither is
    // part of the build, so neither is part of the test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**', 'private/**'],
  },
});
