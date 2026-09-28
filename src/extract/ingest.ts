import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { WriteSource } from '../schema/memory.js';
import { remember, type RememberAction, type RememberResult } from '../ingest/ingest.js';
import type { Extractor } from './types.js';

export interface IngestRawOptions {
  text: string;
  extractor: Extractor;
  /** user 缺省时由引擎 schema 补 default */
  scope?: { user?: string; project?: string; session?: string };
  source?: WriteSource;
  /** 块级幂等前缀(竞赛 request_id):第 i 条候选的幂等键为 `<prefix>:i`,整批重试原样重放 */
  idempotencyKeyPrefix?: string;
  /** 应用到本批每条记忆的来源引用 */
  sourceRef?: string;
}

export interface IngestRawResult {
  extracted: number;
  results: RememberResult[];
}

/**
 * 抽取 + 批量入库:每条候选走真实 remember 管线(去重/冲突/审计原样生效)。
 * 性能关键路径(竞赛全量 Add):
 * 1) 块级幂等短路 —— 派生键全部已存在时直接重放,一次 embedding 都不发生;
 * 2) embedding 与落库分离 —— 支持 embedMany 批量端点,避免逐条 HTTP 调用。
 */
export async function ingestRaw(db: Db, provider: EmbeddingProvider, opts: IngestRawOptions): Promise<IngestRawResult> {
  const memories = await opts.extractor.extract(opts.text);
  const scope = opts.scope ?? {};
  const source: WriteSource = opts.source ?? 'import';

  const idem = opts.idempotencyKeyPrefix;
  if (idem && memories.length > 0) {
    const keys = memories.map((_, i) => `${idem}:${i}`);
    const placeholders = keys.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT key, memory_id, action FROM idempotency_keys WHERE key IN (${placeholders}) ORDER BY key`)
      .all(...keys) as { key: string; memory_id: string; action: string }[];
    if (rows.length === keys.length) {
      const byKey = new Map(rows.map(r => [r.key, r]));
      return {
        extracted: memories.length,
        results: keys.map(k => {
          const r = byKey.get(k)!;
          return { id: r.memory_id, action: r.action as RememberAction };
        }),
      };
    }
  }

  const texts = memories.map(m => [m.content, ...m.keywords].join('\n'));
  let vectors: Float32Array[];
  if (typeof provider.embedMany === 'function') {
    vectors = await provider.embedMany(texts);
  } else {
    vectors = [];
    for (const t of texts) vectors.push(await provider.embed(t));
  }

  const results: RememberResult[] = [];
  let i = 0;
  for (const m of memories) {
    const idempotencyKey = idem ? `${idem}:${i}` : undefined;
    results.push(
      await remember(
        db,
        provider,
        {
          content: m.content,
          type: m.type,
          keywords: m.keywords,
          scope,
          source,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
          ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
        },
        { vector: vectors[i] },
      ),
    );
    i++;
  }
  return { extracted: memories.length, results };
}
