import type { MemoryType, Sensitivity } from '../schema/memory.js';

export const EVAL_CATEGORIES = ['entity', 'paraphrase', 'temporal', 'scope', 'sensitivity', 'conflict'] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface EvalCorpusItem {
  refId: string;
  content: string;
  type?: MemoryType;
  keywords?: string[];
  project?: string;
  session?: string;
  canonicalKey?: string;
  sensitivity?: Sensitivity;
  /** 指向同 case 内更早的 refId,构造 supersedes 链 */
  supersedesRef?: string;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  description?: string;
  corpus: EvalCorpusItem[];
  query: string;
  /** 检索作用域(省略 = user 级) */
  project?: string;
  session?: string;
  includeAncestors?: boolean;
  maxSensitivity?: Sensitivity;
  /** 期望命中的 refId,按相关度从高到低 */
  expectedRefs: string[];
  /** 提供时计算忠实度代理分 */
  answer?: string;
}

export interface CaseMetrics {
  caseId: string;
  category: EvalCategory;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  citationPrecision: number;
  faithfulness: number | null;
  sensitivityLeak: boolean;
  latencyMs: number;
  returnedRefs: string[];
  expectedRefs: string[];
}

export interface SuiteReport {
  suite: string;
  provider: string;
  cases: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  citationPrecision: number;
  faithfulness: number | null;
  p95LatencyMs: number;
  sensitivityLeaks: number;
  perCase: CaseMetrics[];
  generatedAt: string;
}

export interface BaselineComparison {
  ok: boolean;
  regressions: string[];
}
