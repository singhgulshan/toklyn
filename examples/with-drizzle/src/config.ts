export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run this example`);
  return value;
}

/** The SQLite file, created next to package.json unless SQLITE_PATH is set. */
export function sqlitePath(): string {
  return process.env.SQLITE_PATH ?? 'toklyn-example.db';
}
