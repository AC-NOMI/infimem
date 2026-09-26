import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { WriteSource } from '../schema/memory.js';
import { remember, type RememberResult } from '../ingest/ingest.js';
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

/** 抽取 + 批量入库:每条候选走真实 remember 管线(去重/冲突/审计原样生效) */
export async function ingestRaw(db: Db, provider: EmbeddingProvider, opts: IngestRawOptions): Promise<IngestRawResult> {
  const memories = await opts.extractor.extract(opts.text);
  const scope = opts.scope ?? {};
  const source: WriteSource = opts.source ?? 'import';
  const results: RememberResult[] = [];
  let i = 0;
  for (const m of memories) {
    const idempotencyKey = opts.idempotencyKeyPrefix ? `${opts.idempotencyKeyPrefix}:${i}` : undefined;
    results.push(
      await remember(db, provider, {
        content: m.content,
        type: m.type,
        keywords: m.keywords,
        scope,
        source,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
        ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
      }),
    );
    i++;
  }
  return { extracted: memories.length, results };
}
