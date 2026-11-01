import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) =>
  fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// Tests run against the package sources, so they need no build first.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^toklyn$/, replacement: source('core/src/index.ts') },
      { find: /^toklyn\/http$/, replacement: source('core/src/http/index.ts') },
      {
        find: /^toklyn\/test-utils$/,
        replacement: source('core/src/test-utils/index.ts'),
      },
      {
        find: /^@toklyn\/express$/,
        replacement: source('express/src/index.ts'),
      },
    ],
  },
});
