import { openDb, type Db } from '../src/db/connection.js';
import { HashEmbeddingProvider } from '../src/embeddings/hash.js';
import type { EmbeddingProvider } from '../src/embeddings/types.js';

export function makeDb(): Db {
  return openDb(':memory:');
}

export const hashProvider = new HashEmbeddingProvider();

/** 一个确定性 provider,便于断言向量回链正确性(维度默认与 memories_vec 表一致) */
export function fixedProvider(dim = 384, value = 0.5): EmbeddingProvider {
  return {
    name: 'fixed-test',
    dim,
    async embed() {
      return new Float32Array(dim).fill(value);
    },
  };
}

/** 永远失败的 provider,用于测 vec_pending 降级路径 */
export function brokenProvider(): EmbeddingProvider {
  return {
    name: 'broken-test',
    dim: 384,
    async embed() {
      throw new Error('embedding backend down');
    },
  };
}
