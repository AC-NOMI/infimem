import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai.js';
import { getProviderFromEnv } from '../../src/embeddings/env.js';
import { openDb } from '../../src/db/connection.js';
import { remember } from '../../src/ingest/ingest.js';
import { search } from '../../src/retrieval/search.js';
import { fixedProvider } from '../helpers.js';

function mockFetch(payload: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: any, init: any) => {
    capture?.(String(url), init ?? {});
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;
}

describe('OpenAIEmbeddingProvider(泛化后)', () => {
  it('sends model/dimensions/authorization to the configured endpoint', async () => {
    let captured: { url: string; auth: string; body: any } | null = null;
    const p = new OpenAIEmbeddingProvider({
      apiKey: 'k-test',
      model: 'm1',
      dim: 8,
      dimRange: [1, 3072],
      endpoint: 'https://example.com/v1/embeddings',
      fetchImpl: mockFetch({ data: [{ embedding: new Array(8).fill(0.1) }] }, (url, init) => {
        captured = {
          url,
          auth: (init.headers as Record<string, string>).authorization,
          body: JSON.parse(init.body as string),
        };
      }),
    });
    const v = await p.embed('hello world');
    expect(captured!.url).toBe('https://example.com/v1/embeddings');
    expect(captured!.auth).toBe('Bearer k-test');
    expect(captured!.body).toMatchObject({ model: 'm1', input: 'hello world', dimensions: 8 });
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(8);
  });

  it('throws InfimemError on http error status', async () => {
    const p = new OpenAIEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as typeof fetch,
    });
    await expect(p.embed('x')).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the returned embedding dimension mismatches', async () => {
    const p = new OpenAIEmbeddingProvider({
      apiKey: 'k',
      dim: 8,
      dimRange: [1, 3072],
      fetchImpl: mockFetch({ data: [{ embedding: [1, 2, 3] }] }),
    });
    await expect(p.embed('x')).rejects.toThrow(/3 dims/);
  });

  it('validates dim against a per-provider range (default [512,3072])', () => {
    expect(() => new OpenAIEmbeddingProvider({ apiKey: 'k', dim: 256 })).toThrow(/dim/);
    expect(() => new OpenAIEmbeddingProvider({ apiKey: 'k', dim: 256, dimRange: [64, 2048] })).not.toThrow();
  });
});

describe('getProviderFromEnv: INFIMEM_EMBEDDING=v4(DashScope text-embedding-v4)', () => {
  beforeEach(() => {
    process.env.INFIMEM_EMBEDDING = 'v4';
    process.env.INFIMEM_DASHSCOPE_API_KEY = 'sk-dash-test';
    delete process.env.INFIMEM_EMBEDDING_DIM;
  });
  afterEach(() => {
    delete process.env.INFIMEM_EMBEDDING;
    delete process.env.INFIMEM_DASHSCOPE_API_KEY;
  });

  it('builds the v4 provider: dim 1024 default, distinct name (no network in env test)', () => {
    const p = getProviderFromEnv();
    expect(p.name).toBe('text-embedding-v4');
    expect(p.dim).toBe(1024);
  });

  it('honors INFIMEM_EMBEDDING_DIM within [64,2048]', () => {
    process.env.INFIMEM_EMBEDDING_DIM = '256';
    const p = getProviderFromEnv();
    expect(p.dim).toBe(256);
  });

  it('requires INFIMEM_DASHSCOPE_API_KEY', () => {
    delete process.env.INFIMEM_DASHSCOPE_API_KEY;
    expect(() => getProviderFromEnv()).toThrow(/INFIMEM_DASHSCOPE_API_KEY/);
  });
});

describe('dimension-bound database chain (1024 维端到端)', () => {
  it('remember + search work on a dim-1024 database with a dim-1024 provider', async () => {
    const db = openDb(':memory:', { dim: 1024 });
    const r = await remember(db, fixedProvider(1024, 0.25), { content: 'dim chain probe pnpm' });
    const out = await search(db, fixedProvider(1024, 0.25), { query: 'pnpm' });
    expect(out.results[0]!.id).toBe(r.id);
    expect(out.results[0]!.scores.vec).toBeDefined();
    db.close();
  });
});
