/**
 * 检索指标。约定:expected 为空时视为"不该召回什么",不惩罚召回率/MRR。
 */

export function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(retrieved.slice(0, k));
  const hits = expected.filter((e) => top.has(e)).length;
  return hits / expected.length;
}

export function mrr(retrieved: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  const expectedSet = new Set(expected);
  const rank = retrieved.findIndex((r) => expectedSet.has(r));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/** 引用正确率:返回结果中期望项的占比(没有返回就没有错误引用) */
export function citationPrecision(retrieved: string[], expected: string[]): number {
  if (retrieved.length === 0) return 1;
  const expectedSet = new Set(expected);
  const hits = retrieved.filter((r) => expectedSet.has(r)).length;
  return hits / retrieved.length;
}

/**
 * 答案忠实度代理(v0.1,词面 grounding):答案词元(简单去复数)被引用正文支持的比例。
 * 诚实声明:这是词面代理,不是语义判断;LLM judge 列为 v0.2。
 */
export function faithfulnessProxy(answer: string, citedContents: string[]): number {
  const tokens = (answer.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
  if (tokens.length === 0) return 1;
  const cited = citedContents.join(' ').toLowerCase();
  const supported = tokens.filter((t) => {
    const stem = t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
    return cited.includes(stem);
  });
  return supported.length / tokens.length;
}

/** P95:ceil(0.95n)-1 位,样本不足 1 时取最大 */
export function p95(latenciesMs: number[]): number {
  if (latenciesMs.length === 0) return 0;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[idx]!);
}
