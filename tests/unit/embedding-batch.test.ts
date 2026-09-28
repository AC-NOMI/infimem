import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingProvider } from '../../src/embeddings/openai.js';
import { HashEmbeddingProvider } from '../../src/embeddings/hash.js';
import { openDb } from '../../src/db/connection.js';
import { remember } from '../../src/ingest/ingest.js';
import { ingestRaw } from '../../src/extract/ingest.js';
import { HeuristicExtractor } from '../../src/extract/heuristic.js';

describe('OpenAIEmbeddingProvider.embedMany(批量端点)', () => {
  it('batches inputs by batchSize and preserves order across batches', async () => {
    const calls: string[][] = [];
    const p = new OpenAIEmbeddingProvider({
      apiKey: 'k',
      dim: 4,
      dimRange: [1, 3072],
      name: 'batch-test',
      batchSize: 10,
      fetchImpl: (async (url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push(body.input);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: (body.input as string[]).map((t, i) => ({ embedding: [t.length, i + calls.length * 10, 0, 0] })),
          }),
        };
      }) as typeof fetch,
    });
    const texts = Array.from({ length: 25 }, (_, i) => 'x'.repeat(i + 1));
    const vecs = await p.embedMany(texts);
    expect(calls.length).toBe(3); // 10 + 10 + 5
    expect(calls[0].length).toBe(10);
    expect(calls[2].length).toBe(5);
    expect(vecs).toHaveLength(25);
    expect(vecs[0]![0]).toBe(1);  // 'x'
    expect(vecs[24]![0]).toBe(25); // 24 个 x + 1
  });
});

describe('HashEmbeddingProvider.embedMany', () => {
  it('returns the same vectors as individual embed calls', async () => {
    const p = new HashEmbeddingProvider();
    const texts = ['deploy with pnpm', '用户偏好 pnpm 包管理'];
    const many = await p.embedMany(texts);
    for (let i = 0; i < texts.length; i++) {
      const single = await p.embed(texts[i]);
      expect(Array.from(many[i]!)).toEqual(Array.from(single));
    }
  });
});

describe('remember with precomputed vector(内部向量参数)', () => {
  it('skips provider.embed entirely when a vector is supplied', async () => {
    let embedCalls = 0;
    const counting = {
      name: 'counting',
      dim: 384,
      embed: async () => {
        embedCalls++;
        return new Float32Array(384);
      },
    };
    const db = openDb(':memory:');
    const r = await remember(db, counting, { content: 'precomputed probe' }, { vector: new Float32Array(384).fill(0.5) });
    expect(embedCalls).toBe(0);
    expect(r.action).toBe('created');
    const memRowid = (db.prepare('SELECT rowid AS r FROM memories WHERE id = ?').get(r.id) as { r: number }).r;
    const vecRow = db.prepare('SELECT memory_rowid FROM memories_vec WHERE memory_rowid = ?').get(BigInt(memRowid));
    expect(vecRow).toBeDefined();
    db.close();
  });

  it('discards a dimension-mismatched vector and degrades to vec_pending', async () => {
    let embedCalls = 0;
    const counting = {
      name: 'counting-bad',
      dim: 999, // 与 384 维表不匹配的 provider
      embed: async () => {
        embedCalls++;
        return new Float32Array(999);
      },
    };
    const db = openDb(':memory:');
    const r = await remember(db, counting, { content: 'mismatch probe' }, { vector: new Float32Array(999).fill(0.5) });
    expect(r.action).toBe('created');
    const row = db.prepare('SELECT vec_pending FROM memories WHERE id = ?').get(r.id) as { vec_pending: number };
    expect(row.vec_pending).toBe(1);
    expect((db.prepare('SELECT count(*) AS c FROM memories_vec').get() as { c: number }).c).toBe(0);
    void embedCalls;
    db.close();
  });
});

describe('ingestRaw 批量 embedding 与幂等短路', () => {
  function trackingProvider() {
    const embedManyCalls: number[] = [];
    return {
      provider: {
        name: 'tracking',
        dim: 4,
        embed: async () => {
          throw new Error('single embed should not be used when embedMany exists');
        },
        embedMany: async (texts: string[]) => {
          embedManyCalls.push(texts.length);
          return texts.map(() => new Float32Array(4).fill(0.5));
        },
      },
      stats: () => ({ embedManyCalls }),
    };
  }

  it('embeds the whole batch once via embedMany', async () => {
    const { provider, stats } = trackingProvider();
    const d = openDb(':memory:', { dim: 4 });
    const o = await ingestRaw(d, provider, {
      text: '偏好:用 pnpm\n偏好:周五发布',
      extractor: new HeuristicExtractor(),
      scope: {},
    });
    expect(o.extracted).toBe(2);
    expect(o.results.every(r => r.action === 'created')).toBe(true);
    expect(stats().embedManyCalls).toEqual([2]);
    d.close();
  });

  it('short-circuits idempotent replays without calling embed again', async () => {
    const { provider, stats } = trackingProvider();
    const d = openDb(':memory:', { dim: 4 });
    const text = '偏好:用 pnpm\n偏好:周五发布';
    const o1 = await ingestRaw(d, provider, { text, extractor: new HeuristicExtractor(), scope: {}, idempotencyKeyPrefix: 'req:9' });
    const o2 = await ingestRaw(d, provider, { text, extractor: new HeuristicExtractor(), scope: {}, idempotencyKeyPrefix: 'req:9' });
    expect(o2.results.map(r => r.id)).toEqual(o1.results.map(r => r.id));
    expect(stats().embedManyCalls).toEqual([2]); // 重放未再 embed
    d.close();
  });
});
