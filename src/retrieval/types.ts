import type { MemoryRecord } from '../schema/row.js';

/**
 * 检索结果(FEATURES §3.2 扁平结构):引用字段在顶层,另附各阶段分数。
 * fts = BM25 rank(越小越好);vec = 余弦距离(越小越好);rrf = 融合分(越大越好)。
 */
export type ScoredResult = MemoryRecord & {
  scores: { fts?: number; vec?: number; rrf: number; rerank?: number };
};

export interface SearchTrace {
  ftsCandidates: number;
  vecCandidates: number;
  fused: number;
  reranker: string;
  elapsedMs: { total: number; recall: number; fuse: number; rerank: number };
}

export interface SearchOutput {
  results: ScoredResult[];
  trace: SearchTrace;
}
