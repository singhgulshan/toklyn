import { MemorySessionStore } from '#src/index.js';
import { sessionStoreContract } from '#src/testing/index.js';

sessionStoreContract('MemorySessionStore', () => new MemorySessionStore());
