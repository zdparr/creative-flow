import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources so tests do not depend on a prior build.
    alias: {
      '@storyforge/core': src('core'),
      '@storyforge/db': src('db'),
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
  },
});
