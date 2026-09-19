import type { ScoredResult } from './types.js';

/** 重排钩子(章程 §4.3):输入 RRF 融合后的候选,输出重排后的候选。可替换为本地关键词或 API 实现。 */
export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: ScoredResult[]): Promise<ScoredResult[]>;
}

/** v0.1 默认:保持 RRF 序,仅记录分数。 */
export class IdentityReranker implements Reranker {
  readonly name = 'identity';

  async rerank(_query: string, candidates: ScoredResult[]): Promise<ScoredResult[]> {
    for (const c of candidates) c.scores.rerank = c.scores.rrf;
    return candidates;
  }
}
