import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = (path: string) =>
  fileURLToPath(new URL(`../core/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^toklyn$/, replacement: core('index.ts') },
      { find: /^toklyn\/testing$/, replacement: core('testing/index.ts') },
    ],
  },
});
