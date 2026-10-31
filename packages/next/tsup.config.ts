import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', server: 'src/server.ts' },
  format: ['esm', 'cjs'],
  // Without the source paths, declarations import `toklyn` instead of inlining core types.
  dts: {
    compilerOptions: { paths: { 'next/*': ['./node_modules/next/*.d.ts'] } },
  },
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});
