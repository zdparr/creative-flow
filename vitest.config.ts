import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const path = (file: string) => fileURLToPath(new URL(`./packages/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources so tests do not depend on a prior build.
    alias: [
      { find: '@storyforge/core/testing', replacement: path('core/src/testing/index.ts') },
      { find: '@storyforge/db/testing', replacement: path('db/src/testing.ts') },
      { find: '@storyforge/services/testing', replacement: path('services/src/testing.ts') },
      { find: '@storyforge/core', replacement: path('core/src/index.ts') },
      { find: '@storyforge/db', replacement: path('db/src/index.ts') },
      { find: '@storyforge/services', replacement: path('services/src/index.ts') },
    ],
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Database tests run on in-process Postgres (PGlite), which is slow to start on some machines.
    testTimeout: 30_000,
  },
});
