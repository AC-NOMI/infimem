import { InfimemError } from '../errors.js';
import type { EmbeddingProvider } from './types.js';

/**
 * OpenAI 兼容 embeddings 端点适配器:覆盖 OpenAI 与 DashScope 兼容模式
 * (text-embedding-v4 等)。维度范围按 provider 声明,数据库维度在建库时绑定。
 */
export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  model?: string;
  dim?: number;
  endpoint?: string;
  /** 上报名(评测报告 / /health 用),默认 openai */
  name?: string;
  /** 该 provider 允许的维度区间,默认 [512, 3072](text-embedding-v4 为 [64, 2048]) */
  dimRange?: [number, number];
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly dimRange: [number, number];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingProviderOptions = {}) {
    this.name = opts.name ?? 'openai';
    this.apiKey = opts.apiKey ?? process.env.INFIMEM_OPENAI_API_KEY ?? '';
    this.model = opts.model ?? process.env.INFIMEM_OPENAI_MODEL ?? 'text-embedding-3-small';
    this.dim = opts.dim ?? Number(process.env.INFIMEM_OPENAI_DIM ?? 1536);
    this.endpoint = opts.endpoint ?? process.env.INFIMEM_OPENAI_BASE_URL ?? 'https://api.openai.com/v1/embeddings';
    this.dimRange = opts.dimRange ?? [512, 3072];
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    if (!this.apiKey) throw new InfimemError('OpenAIEmbeddingProvider requires an API key');
    const [min, max] = this.dimRange;
    if (!Number.isInteger(this.dim) || this.dim < min || this.dim > max) {
      throw new InfimemError(`embedding dim must be an integer in [${min}, ${max}] for ${this.name}, got ${this.dim}`);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: text, dimensions: this.dim }),
      });
    } catch (e) {
      throw new InfimemError(`embedding request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new InfimemError(`embedding request failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    const vec = data.data?.[0]?.embedding;
    if (!vec || vec.length !== this.dim) {
      throw new InfimemError(`embedding endpoint returned ${vec?.length ?? 0} dims, expected ${this.dim}`);
    }
    return new Float32Array(vec);
  }
}
