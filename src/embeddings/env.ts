import { HashEmbeddingProvider } from './hash.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider } from './types.js';
import { InfimemError } from '../errors.js';

/** INFIMEM_EMBEDDING=hash(默认,零依赖)| openai(需 INFIMEM_OPENAI_API_KEY) */
export function getProviderFromEnv(): EmbeddingProvider {
  const kind = process.env.INFIMEM_EMBEDDING ?? 'hash';
  if (kind === 'hash') return new HashEmbeddingProvider();
  if (kind === 'openai') {
    if (!process.env.INFIMEM_OPENAI_API_KEY) {
      throw new InfimemError('INFIMEM_OPENAI_API_KEY is required when INFIMEM_EMBEDDING=openai');
    }
    return new OpenAIEmbeddingProvider();
  }
  throw new InfimemError(`unknown INFIMEM_EMBEDDING: ${kind} (supported: hash, openai)`);
}
