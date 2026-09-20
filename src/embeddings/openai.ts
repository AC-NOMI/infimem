import { InfimemError } from '../errors.js';
import type { EmbeddingProvider } from './types.js';

/**
 * OpenAI 适配器(D2 的可选增强)。文本向量维数可用 INFIMEM_OPENAI_DIM 调整,
 * 但必须与建库时的维度一致(v0.1 每个库绑定一个 provider 维度)。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dim: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(opts: { apiKey?: string; model?: string; dim?: number; endpoint?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.INFIMEM_OPENAI_API_KEY ?? '';
    this.model = opts.model ?? process.env.INFIMEM_OPENAI_MODEL ?? 'text-embedding-3-small';
    this.dim = opts.dim ?? Number(process.env.INFIMEM_OPENAI_DIM ?? 1536);
    this.endpoint = opts.endpoint ?? 'https://api.openai.com/v1/embeddings';
    if (!this.apiKey) throw new InfimemError('OpenAIEmbeddingProvider requires an API key');
    if (!Number.isInteger(this.dim) || this.dim < 512 || this.dim > 3072) {
      throw new InfimemError(`INFIMEM_OPENAI_DIM must be an integer in [512, 3072], got ${this.dim}`);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: text, dimensions: this.dim }),
      });
    } catch (e) {
      throw new InfimemError(`openai embeddings request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new InfimemError(`openai embeddings failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    const vec = data.data[0]?.embedding;
    if (!vec || vec.length !== this.dim) {
      throw new InfimemError(`openai embeddings returned ${vec?.length ?? 0} dims, expected ${this.dim}`);
    }
    return new Float32Array(vec);
  }
}
