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
  for (const m of memories) {
    results.push(
      await remember(db, provider, {
        content: m.content,
        type: m.type,
        keywords: m.keywords,
        scope,
        source,
        ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
      }),
    );
  }
  return { extracted: memories.length, results };
}
