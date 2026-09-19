import { normalizeContent } from '../schema/keys.js';
import type { EmbeddingProvider } from './types.js';

export const HASH_EMBEDDING_DIM = 384;

/**
 * 特征哈希 embedding:词元 + CJK 字符二元组 → fnv1a 哈希 → 带符号累加 → L2 归一化。
 * 确定性、零依赖、离线可用;语义泛化弱(接近词面匹配),检索以 FTS5 为主力、此为副手。
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly dim = HASH_EMBEDDING_DIM;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    for (const feature of extractFeatures(text)) {
      const h = fnv1a32(feature);
      vec[h % this.dim] += (h >>> 31) === 1 ? -1 : 1;
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    return vec;
  }
}

function extractFeatures(text: string): string[] {
  const normalized = normalizeContent(text);
  const features: string[] = [];
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    features.push(`w:${word}`);
  }
  for (const run of normalized.match(/[\u4e00-\u9fff\u3040-\u30ff]+/g) ?? []) {
    for (let i = 0; i < run.length; i++) {
      features.push(`g:${run.slice(i, i + 2)}`);
    }
  }
  return features;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
