import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Without the source paths, declarations import `toklyn` instead of inlining core types.
  dts: { compilerOptions: { paths: {} } },
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});
