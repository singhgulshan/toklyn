import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'postgres/index': 'src/postgres/index.ts',
    'mysql/index': 'src/mysql/index.ts',
    'sqlite/index': 'src/sqlite/index.ts',
    'redis/index': 'src/redis/index.ts',
  },
  format: ['esm', 'cjs'],
  // Without the source paths, declarations import `toklyn` instead of inlining core types.
  dts: { compilerOptions: { paths: {} } },
  // Shared code becomes one chunk instead of a copy per entry, in CJS too.
  splitting: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
});
