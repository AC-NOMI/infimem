import { openDb } from '../db/connection.js';
import { remember } from '../ingest/ingest.js';
import { search } from '../retrieval/search.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { citationPrecision, faithfulnessProxy, mrr, p95, recallAtK } from './metrics.js';
import type { BaselineComparison, CaseMetrics, EvalCase, SuiteReport } from './types.js';

/**
 * 评测运行器(FEATURES §8):每个 case 独立内存库,语料经真实 remember 管线注入,
 * 查询走真实 search 管线——评测的是产品路径,不是测试替身。
 */
export async function runSuite(provider: EmbeddingProvider, cases: EvalCase[], suiteName: string): Promise<SuiteReport> {
  const perCase: CaseMetrics[] = [];
  const latencies: number[] = [];
  let leaks = 0;

  for (const c of cases) {
    const db = openDb(':memory:', { dim: provider.dim });
    try {
      const refToId = new Map<string, string>();
      for (const item of c.corpus) {
        const r = await remember(db, provider, {
          content: item.content,
          keywords: item.keywords ?? [],
          ...(item.type ? { type: item.type } : {}),
          scope: { project: item.project, session: item.session },
          ...(item.canonicalKey ? { canonicalKey: item.canonicalKey } : {}),
          ...(item.sensitivity ? { sensitivity: item.sensitivity } : {}),
          ...(item.supersedesRef ? { supersedes: refToId.get(item.supersedesRef) } : {}),
        });
        refToId.set(item.refId, r.id);
      }

      const t0 = performance.now();
      const out = await search(db, provider, {
        query: c.query,
        k: 10,
        scope: { project: c.project, session: c.session },
        ...(c.includeAncestors !== undefined ? { includeAncestors: c.includeAncestors } : {}),
        maxSensitivity: c.maxSensitivity ?? 'normal',
      });
      const latencyMs = performance.now() - t0;
      latencies.push(latencyMs);

      const idToRef = new Map([...refToId.entries()].map(([ref, id]) => [id, ref]));
      const returnedRefs = out.results.map((r) => idToRef.get(r.id)!);

      const sensitiveRefs = new Set(c.corpus.filter((i) => i.sensitivity === 'sensitive').map((i) => i.refId));
      const leak = c.maxSensitivity !== 'sensitive' && returnedRefs.some((ref) => sensitiveRefs.has(ref));
      if (leak) leaks++;

      perCase.push({
        caseId: c.id,
        category: c.category,
        recallAt1: recallAtK(returnedRefs, c.expectedRefs, 1),
        recallAt5: recallAtK(returnedRefs, c.expectedRefs, 5),
        recallAt10: recallAtK(returnedRefs, c.expectedRefs, 10),
        mrr: mrr(returnedRefs, c.expectedRefs),
        citationPrecision: citationPrecision(returnedRefs, c.expectedRefs),
        faithfulness: c.answer ? faithfulnessProxy(c.answer, out.results.map((r) => r.content)) : null,
        sensitivityLeak: leak,
        latencyMs,
        returnedRefs,
        expectedRefs: c.expectedRefs,
      });
    } finally {
      db.close();
    }
  }

  const mean = (xs: number[]): number => (xs.length === 0 ? 1 : xs.reduce((s, x) => s + x, 0) / xs.length);
  const faithfulnessValues = perCase.map((p) => p.faithfulness).filter((f): f is number => f !== null);

  return {
    suite: suiteName,
    provider: provider.name,
    cases: perCase.length,
    recallAt1: mean(perCase.map((p) => p.recallAt1)),
    recallAt5: mean(perCase.map((p) => p.recallAt5)),
    recallAt10: mean(perCase.map((p) => p.recallAt10)),
    mrr: mean(perCase.map((p) => p.mrr)),
    citationPrecision: mean(perCase.map((p) => p.citationPrecision)),
    faithfulness: faithfulnessValues.length > 0 ? mean(faithfulnessValues) : null,
    p95LatencyMs: p95(latencies),
    sensitivityLeaks: leaks,
    perCase,
    generatedAt: new Date().toISOString(),
  };
}

const TRACKED_METRICS = ['recallAt1', 'recallAt5', 'recallAt10', 'mrr', 'citationPrecision'] as const;

/** CI 回归门(章程 §4.6):任一指标绝对退化超过阈值即失败;敏感泄漏必须保持为 0。 */
export function compareWithBaseline(
  report: SuiteReport,
  baseline: SuiteReport,
  opts: { maxAbsoluteDrop?: number } = {},
): BaselineComparison {
  const maxDrop = opts.maxAbsoluteDrop ?? 0.02;
  const regressions: string[] = [];
  for (const key of TRACKED_METRICS) {
    const base = baseline[key];
    const now = report[key];
    if (base - now > maxDrop) regressions.push(key);
  }
  if (report.sensitivityLeaks > baseline.sensitivityLeaks) regressions.push('sensitivityLeaks');
  return { ok: regressions.length === 0, regressions };
}

export function reportToMarkdown(report: SuiteReport): string {
  const lines = [
    `# Eval report — ${report.suite} (provider: ${report.provider})`,
    '',
    `Generated: ${report.generatedAt} · Cases: ${report.cases}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Recall@1 | ${report.recallAt1.toFixed(3)} |`,
    `| Recall@5 | ${report.recallAt5.toFixed(3)} |`,
    `| Recall@10 | ${report.recallAt10.toFixed(3)} |`,
    `| MRR | ${report.mrr.toFixed(3)} |`,
    `| Citation precision | ${report.citationPrecision.toFixed(3)} |`,
    `| Faithfulness (lexical proxy) | ${report.faithfulness === null ? 'n/a' : report.faithfulness.toFixed(3)} |`,
    `| P95 latency | ${report.p95LatencyMs} ms |`,
    `| Sensitivity leaks | ${report.sensitivityLeaks} |`,
    '',
    '| Case | Category | R@5 | MRR | Cite P | Leak |',
    '|---|---|---|---|---|---|',
    ...report.perCase.map(
      (p) =>
        `| ${p.caseId} | ${p.category} | ${p.recallAt5.toFixed(2)} | ${p.mrr.toFixed(2)} | ${p.citationPrecision.toFixed(2)} | ${p.sensitivityLeak ? 'YES' : ''} |`,
    ),
  ];
  return lines.join('\n');
}
