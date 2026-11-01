export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run this example`);
  return value;
}

/** The SQLite file, created next to package.json unless SQLITE_PATH is set. */
export function sqlitePath(): string {
  return process.env.SQLITE_PATH ?? 'toklyn-example.db';
}

/** `mysql://user:password@host:port/database` as connection options. */
export function mysqlOptions(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  };
}
