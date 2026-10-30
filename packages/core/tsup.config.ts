import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'http/index': 'src/http/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // Shared chunks in CJS too, so `instanceof ToklynError` works across subpaths.
  splitting: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});
