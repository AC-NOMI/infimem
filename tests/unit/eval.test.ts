import { describe, expect, it } from 'vitest';
import {
  recallAtK,
  mrr,
  citationPrecision,
  faithfulnessProxy,
} from '../../src/eval/metrics.js';
import { runSuite, compareWithBaseline } from '../../src/eval/run.js';
import type { EvalCase, SuiteReport } from '../../src/eval/types.js';
import { HashEmbeddingProvider } from '../../src/embeddings/hash.js';

describe('retrieval metrics', () => {
  it('recall@k counts expected items within top-k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a'], 1)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], ['a', 'd'], 5)).toBe(0.5);
    expect(recallAtK(['a', 'b'], [], 5)).toBe(1); // 无期望时不惩罚
  });

  it('mrr is the reciprocal rank of the first expected hit', () => {
    expect(mrr(['a', 'b', 'c'], ['b'])).toBe(0.5);
    expect(mrr(['b', 'a'], ['a', 'b'])).toBe(1);
    expect(mrr(['x', 'y'], ['z'])).toBe(0);
  });

  it('citation precision is the share of returned items that were expected', () => {
    expect(citationPrecision(['a', 'x'], ['a'])).toBeCloseTo(0.5);
    expect(citationPrecision([], ['a'])).toBe(1); // 没有返回就没有错误引用
  });

  it('faithfulness proxy rewards answers grounded in cited content', () => {
    const cited = 'backend deploys use pnpm workspace';
    expect(faithfulnessProxy('deploys use pnpm', [cited])).toBe(1);
    expect(faithfulnessProxy('deploys use kubernetes', [cited])).toBeLessThan(1);
    expect(faithfulnessProxy('', [cited])).toBe(1);
  });
});

describe('runSuite', () => {
  const cases: EvalCase[] = [
    {
      id: 't1',
      category: 'entity',
      corpus: [{ refId: 'c1', content: 'deploy with pnpm' }],
      query: 'pnpm',
      expectedRefs: ['c1'],
      answer: 'deploys with pnpm',
    },
    {
      id: 't2',
      category: 'paraphrase',
      corpus: [{ refId: 'c2', content: ' quantum flux capacitor repairs' }],
      query: 'zzz unrelated query',
      expectedRefs: ['c2'],
    },
  ];

  it('computes per-case and aggregate metrics with latency and leak accounting', async () => {
    const report = await runSuite(new HashEmbeddingProvider(), cases, 'unit-test');
    expect(report.cases).toBe(2);
    expect(report.perCase).toHaveLength(2);
    const t1 = report.perCase.find((p) => p.caseId === 't1')!;
    expect(t1.recallAt1).toBe(1);
    expect(t1.mrr).toBe(1);
    expect(t1.faithfulness).toBe(1);
    expect(report.p95LatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.sensitivityLeaks).toBe(0);
  });

  it('flags a sensitivity leak when a sensitive corpus item is returned under normal ceiling', async () => {
    const leaky: EvalCase[] = [
      {
        id: 's1',
        category: 'sensitivity',
        corpus: [
          { refId: 'secret', content: 'vault key under the mat', sensitivity: 'sensitive' },
          { refId: 'safe', content: 'vault key rotation policy', sensitivity: 'normal' },
        ],
        query: 'vault key',
        expectedRefs: ['safe'],
      },
    ];
    // 直接用 normal 上限:实现应当过滤,泄漏应为 0
    const report = await runSuite(new HashEmbeddingProvider(), leaky, 'leak-test');
    expect(report.sensitivityLeaks).toBe(0);
    expect(report.perCase[0]!.sensitivityLeak).toBe(false);
  });
});

describe('compareWithBaseline', () => {
  const base: SuiteReport = {
    suite: 'v1',
    provider: 'hash',
    cases: 1,
    recallAt1: 1,
    recallAt5: 0.9,
    recallAt10: 1,
    mrr: 0.8,
    citationPrecision: 1,
    faithfulness: 1,
    p95LatencyMs: 5,
    sensitivityLeaks: 0,
    perCase: [],
    generatedAt: '2026-01-01',
  };

  it('passes when metrics match or improve', () => {
    const result = compareWithBaseline({ ...base }, base);
    expect(result.ok).toBe(true);
    const better = compareWithBaseline({ ...base, recallAt5: 1 }, base);
    expect(better.ok).toBe(true);
  });

  it('fails and names the regressed metric beyond the tolerance', () => {
    const worse = compareWithBaseline({ ...base, recallAt5: 0.85, mrr: 0.6 }, base);
    expect(worse.ok).toBe(false);
    expect(worse.regressions).toContain('recallAt5');
    expect(worse.regressions).toContain('mrr');
  });

  it('tolerates drops within the absolute threshold', () => {
    const result = compareWithBaseline({ ...base, mrr: 0.79 }, base);
    expect(result.ok).toBe(true);
  });
});
