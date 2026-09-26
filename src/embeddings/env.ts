import { HashEmbeddingProvider } from './hash.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider } from './types.js';
import { InfimemError } from '../errors.js';

/**
 * INFIMEM_EMBEDDING 选择 provider:
 * - hash(默认):零依赖离线,评测基线
 * - openai:OpenAI 官方(INFIMEM_OPENAI_*)
 * - v4:DashScope 兼容模式 text-embedding-v4(INFIMEM_DASHSCOPE_API_KEY;维度 INFIMEM_EMBEDDING_DIM,默认 1024,范围 [64,2048])
 */
export function getProviderFromEnv(): EmbeddingProvider {
  const kind = process.env.INFIMEM_EMBEDDING ?? 'hash';
  if (kind === 'hash') return new HashEmbeddingProvider();
  if (kind === 'openai') {
    if (!process.env.INFIMEM_OPENAI_API_KEY) {
      throw new InfimemError('INFIMEM_OPENAI_API_KEY is required when INFIMEM_EMBEDDING=openai');
    }
    return new OpenAIEmbeddingProvider();
  }
  if (kind === 'v4' || kind === 'text-embedding-v4') {
    const apiKey = process.env.INFIMEM_DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new InfimemError('INFIMEM_DASHSCOPE_API_KEY is required when INFIMEM_EMBEDDING=v4');
    }
    return new OpenAIEmbeddingProvider({
      apiKey,
      name: 'text-embedding-v4',
      model: process.env.INFIMEM_EMBEDDING_MODEL ?? 'text-embedding-v4',
      endpoint:
        process.env.INFIMEM_EMBEDDING_BASE_URL ??
        'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      dim: Number(process.env.INFIMEM_EMBEDDING_DIM ?? 1024),
      dimRange: [64, 2048],
    });
  }
  throw new InfimemError(`unknown INFIMEM_EMBEDDING: ${kind} (supported: hash, openai, v4)`);
}
