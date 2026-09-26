import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicExtractor } from '../../src/extract/heuristic.js';
import { LlmExtractor, ExtractError } from '../../src/extract/llm.js';
import { ingestRaw } from '../../src/extract/ingest.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { hashProvider } from '../helpers.js';

describe('HeuristicExtractor(规则版,零依赖基线)', () => {
  const ex = new HeuristicExtractor();

  it('prefix markers decide the memory type, prefix stripped from content', async () => {
    const out = await ex.extract('偏好:部署用 pnpm\n事实:办公室在 5 楼\nprocedure: deploy in 3 steps');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type: 'preference', content: '部署用 pnpm' });
    expect(out[1]).toMatchObject({ type: 'fact', content: '办公室在 5 楼' });
    expect(out[2]).toMatchObject({ type: 'procedure', content: 'deploy in 3 steps' });
  });

  it('plain lines default to fact; empty lines are skipped', async () => {
    const out = await ex.extract('第一句记忆\n\n第二句记忆\n   \n');
    expect(out).toHaveLength(2);
    expect(out.every(m => m.type === 'fact')).toBe(true);
  });

  it('strips dialogue role markers and timestamps from transcript lines', async () => {
    const out = await ex.extract("user [2024-01-01T00:00:00.000Z]: 偏好:部署用 pnpm 管理依赖\nassistant: 好的,已记住");
    expect(out[0]).toMatchObject({ type: 'preference', content: '部署用 pnpm 管理依赖' });
    expect(out[1]).toMatchObject({ content: '好的,已记住' });
  });

  it('splits over-long lines at sentence boundaries instead of dropping them', async () => {
    const sentence = '这是一条比较长的记忆句子用来测试分句逻辑。';
    const out = await ex.extract(sentence.repeat(100));
    expect(out.length).toBeGreaterThan(1);
    expect(out.every(m => m.content.length <= 2000)).toBe(true);
  });
});

describe('LlmExtractor(gpt-4o-mini 适配器,mock fetch)', () => {
  const okResponse = (content: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });

  it('parses strict-JSON LLM output into extracted memories', async () => {
    const calls: any[] = [];
    const ex = new LlmExtractor({
      apiKey: 'k',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
        return okResponse('{"memories":[{"content":"uses pnpm","type":"preference","keywords":["pnpm"],"confidence":0.9}]}');
      },
    });
    const out = await ex.extract('raw text');
    expect(out).toEqual([{ content: 'uses pnpm', type: 'preference', keywords: ['pnpm'], confidence: 0.9 }]);
    expect(calls[0].url).toContain('/chat/completions');
    expect(calls[0].body.model).toBe('gpt-4o-mini');
    expect(calls[0].body.messages.some((m: any) => m.role === 'user' && m.content === 'raw text')).toBe(true);
  });

  it('strips markdown fences around the JSON payload', async () => {
    const ex = new LlmExtractor({
      apiKey: 'k',
      fetchImpl: async () => okResponse('```json\n{"memories":[{"content":"x","type":"fact"}]}\n```'),
    });
    const out = await ex.extract('t');
    expect(out[0]).toMatchObject({ content: 'x', type: 'fact' });
  });

  it('throws ExtractError on unparseable output, with one transient retry', async () => {
    let attempts = 0;
    const flaky = new LlmExtractor({
      apiKey: 'k',
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return { ok: false, status: 503, json: async () => ({}) };
        return okResponse('not json at all');
      },
    });
    await expect(flaky.extract('t')).rejects.toBeInstanceOf(ExtractError);
    expect(attempts).toBe(2); // 503 重试一次,再失败于解析
  });

  it('chunks long inputs into multiple LLM calls', async () => {
    let calls = 0;
    const ex = new LlmExtractor({
      apiKey: 'k',
      chunkSize: 50,
      fetchImpl: async () => {
        calls++;
        return okResponse('{"memories":[]}');
      },
    });
    await ex.extract('a'.repeat(120));
    expect(calls).toBe(3); // ceil(120/50)
  });
});

describe('ingestRaw(抽取 + 批量入库,走真实 remember 管线)', () => {
  let db: Db;
  let dbPath: string;
  const newDb = () => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'infimem-ex-')), 'm.db');
    db = openDb(dbPath);
    return db;
  };

  it('extracts then ingests each item; second pass over same text is all duplicates', async () => {
    const d = newDb();
    const first = await ingestRaw(d, hashProvider, {
      text: '偏好:部署用 pnpm\n事实:办公室在 5 楼',
      extractor: new HeuristicExtractor(),
      scope: { project: 'aml' },
    });
    expect(first.extracted).toBe(2);
    expect(first.results.every(r => r.action === 'created')).toBe(true);

    const second = await ingestRaw(d, hashProvider, {
      text: '偏好:部署用 pnpm\n事实:办公室在 5 楼',
      extractor: new HeuristicExtractor(),
      scope: { project: 'aml' },
    });
    expect(second.results.every(r => r.action === 'duplicate')).toBe(true);
    d.close();
  });

  it('derives per-item idempotency keys from the prefix so batch retries replay identically', async () => {
    const d = newDb();
    const text = '偏好:部署用 pnpm\n偏好:周五发布';
    const o1 = await ingestRaw(d, hashProvider, { text, extractor: new HeuristicExtractor(), scope: {}, idempotencyKeyPrefix: 'eval:run1:chunk-0' });
    const o2 = await ingestRaw(d, hashProvider, { text, extractor: new HeuristicExtractor(), scope: {}, idempotencyKeyPrefix: 'eval:run1:chunk-0' });
    expect(o1.results.map(r => r.id)).toEqual(o2.results.map(r => r.id));
    expect((d.prepare('SELECT count(*) c FROM memories').get() as any).c).toBe(2);
    const keys = (d.prepare('SELECT key FROM idempotency_keys ORDER BY key').all() as any[]).map(r => r.key);
    expect(keys).toEqual(['eval:run1:chunk-0:0', 'eval:run1:chunk-0:1']);
    d.close();
  });

  it('sourceRef is applied to every extracted memory', async () => {
    const d = newDb();
    const { results } = await ingestRaw(d, hashProvider, {
      text: '偏好:喜欢深色主题', extractor: new HeuristicExtractor(), scope: {}, sourceRef: 'session:eval:r1:sample:0',
    });
    const row = d.prepare('SELECT source_ref FROM memories WHERE id = ?').get(results[0]!.id) as any;
    expect(row.source_ref).toBe('session:eval:r1:sample:0');
    d.close();
  });

  it('scope is applied to every extracted memory', async () => {
    const d = newDb();
    const { results } = await ingestRaw(d, hashProvider, {
      text: '偏好:喜欢深色主题',
      extractor: new HeuristicExtractor(),
      scope: { project: 'ui', session: 's1' },
    });
    const row = d.prepare('SELECT scope_project, scope_session FROM memories WHERE id = ?').get(results[0]!.id) as any;
    expect(row.scope_project).toBe('ui');
    expect(row.scope_session).toBe('s1');
    d.close();
  });
});
