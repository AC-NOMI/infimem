export { openDb, type Db } from './db/connection.js';
export { remember, type RememberResult, type RememberAction } from './ingest/ingest.js';
export { HashEmbeddingProvider, HASH_EMBEDDING_DIM } from './embeddings/hash.js';
export type { EmbeddingProvider } from './embeddings/types.js';
export { rememberInputSchema, MEMORY_TYPES, SENSITIVITY_LEVELS, WRITE_SOURCES } from './schema/memory.js';
export type { RememberInput, MemoryType, Sensitivity, WriteSource } from './schema/memory.js';
export { InfimemError, ValidationError, NotFoundError } from './errors.js';
