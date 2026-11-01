import { walkthrough } from './walkthrough.js';
import type { Stores } from './walkthrough.js';

interface Variant {
  /** Environment variables the variant needs. */
  needs: readonly string[];
  load(): Promise<{ connect(): Promise<Stores> }>;
}

const variants: Record<string, Variant> = {
  mysql2: { needs: ['MYSQL_URL'], load: () => import('./stores/mysql2.js') },
  mariadb: {
    needs: ['MARIADB_URL'],
    load: () => import('./stores/mariadb.js'),
  },
};

await run(variants);

// `pnpm start <variant>` runs one; `pnpm check` runs every variant whose database is set.
async function run(all: Record<string, Variant>): Promise<void> {
  const [arg] = process.argv.slice(2);
  const runAll = arg === '--all';
  const names = runAll ? Object.keys(all) : [arg ?? ''];
  let failed = false;
  for (const name of names) {
    const variant = all[name];
    if (!variant) {
      console.error(`Usage: pnpm start <${Object.keys(all).join(' | ')}>`);
      process.exitCode = 1;
      return;
    }
    const missing = variant.needs.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.log(`- ${name}: skipped, set ${missing.join(', ')}`);
      if (!runAll) process.exitCode = 1;
      continue;
    }
    console.log(name);
    const stores = await (await variant.load()).connect();
    try {
      await walkthrough(stores);
      console.log(`✓ ${name}\n`);
    } catch (error) {
      failed = true;
      console.error(`✗ ${name}`, error);
    } finally {
      await stores.close();
    }
  }
  if (failed) process.exitCode = 1;
}
