import { useDrivers } from './sqlite.js';
import { sqliteSuites } from './suites.js';

const drivers = useDrivers();

sqliteSuites('node:sqlite, memory', drivers.nodeMemory);
sqliteSuites('node:sqlite, file', drivers.nodeFile);
sqliteSuites('better-sqlite3, memory', drivers.betterMemory);
sqliteSuites('better-sqlite3, file', drivers.betterFile);
sqliteSuites('libSQL, file', drivers.libsqlFile);
