import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { getDbDim } from '../db/meta.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { MEMORY_TYPES, SENSITIVITY_LEVELS, scopeSchema, type Scope } from '../schema/memory.js';
import { MEMORY_COLUMNS, rowToMemory, type MemoryRecord } from '../schema/row.js';
import { ValidationError } from '../errors.js';
import { scopeCondition, scopePairs, SENSITIVITY_SQL } from './scope.js';
import { IdentityReranker, type Reranker } from './rerank.js';
import type { ScoredResult, SearchOutput } from './types.js';

export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(512),
  scope: scopeSchema.optional(),
  includeAncestors: z.boolean().default(true),
  k: z.number().int().min(1).max(20).default(5),
  maxSensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
  type: z.enum(MEMORY_TYPES).optional(),
  // hash 向量下不相关文本的余弦距离 ≈ 1.0;截断是启发式,换 API provider 时可放宽
  maxDistance: z.number().min(0).max(2).default(0.95),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

const RRF_K = 60;
const OVERFETCH_FTS = 50;
const OVERFETCH_VEC = 150;

/**
 * 检索管线(见 FEATURES.md §5):
 * 双路召回(FTS5 BM25 + sqlite-vec KNN,均按 scope/status/敏感级过滤)→ RRF 融合 → rerank 钩子 → Top-K 带引用与各阶段分数。
 */
export async function search(
  db: Db,
  provider: EmbeddingProvider,
  input: unknown,
  reranker: Reranker = new IdentityReranker(),
): Promise<SearchOutput> {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('invalid search input', parsed.error.issues);
  const value = parsed.data;
  const scope: Scope = scopeSchema.parse(value.scope ?? {});

  const t0 = performance.now();
  const candidates = new Map<string, ScoredResult>();

  // 阶段 1a:FTS5 BM25 召回(SQL 内完成过滤)
  const tRecall = performance.now();
  const matchQuery = sanitizeMatchQuery(value.query);
  let ftsCandidates = 0;
  if (matchQuery !== '') {
    const scopeC = scopeCondition(scope, value.includeAncestors);
    const sql = `SELECT ${MEMORY_COLUMNS}, memories_fts.rank AS fts_rank
                 FROM memories_fts JOIN memories ON memories.rowid = memories_fts.rowid
                 WHERE memories_fts MATCH ?
                   AND memories.status = 'active'
                   AND (${scopeC.sql})
                   AND ${SENSITIVITY_SQL}
                   ${value.type ? 'AND memories.type = ?' : ''}
                 ORDER BY fts_rank
                 LIMIT ${OVERFETCH_FTS}`;
    const params: unknown[] = [matchQuery, ...scopeC.params, value.maxSensitivity];
    if (value.type) params.push(value.type);
    const rows = db.prepare(sql).all(...params) as (Record<string, unknown> & { fts_rank: number })[];
    ftsCandidates = rows.length;
    rows.forEach((row, i) => {
      const memory = rowToMemory(row as never);
      candidates.set(memory.id, { ...memory, scores: { fts: row.fts_rank, rrf: rrfScore(i) } });
    });
  }

  // 阶段 1b:向量 KNN 召回(超量取回后置过滤,规模问题留给 v0.3)
  let vecCandidates = 0;
  const dbDim = getDbDim(db);
  if (provider.dim !== dbDim) {
    throw new ValidationError(
      `embedding dimension mismatch: provider dim ${provider.dim} != database dim ${dbDim} (v0.1 keeps one database per provider)`,
    );
  }
  const queryVec = await provider.embed(value.query);
  const knn = db
    .prepare(`SELECT memory_rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ${OVERFETCH_VEC}`)
    .all(Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength)) as {
    memory_rowid: number;
    distance: number;
  }[];
  // 距离截断先于回表:被截断的候选不需要回 memories
  const kept = knn.filter((r) => r.distance <= value.maxDistance);
  if (kept.length > 0) {
    const distanceOf = new Map<number, number>(kept.map((r) => [r.memory_rowid, r.distance]));
    const placeholders = kept.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT ${MEMORY_COLUMNS}, rowid AS _rowid FROM memories WHERE rowid IN (${placeholders})`)
      .all(...kept.map((r) => r.memory_rowid)) as (Record<string, unknown> & { _rowid: number })[];
    const scoped = rows.filter((row) => {
      if (row.status !== 'active') return false;
      if (!sensitivityAtMost(row.sensitivity as string, value.maxSensitivity)) return false;
      if (value.type && row.type !== value.type) return false;
      return matchesScope(
        { user: row.scope_user as string, project: row.scope_project as string | null, session: row.scope_session as string | null },
        scope,
        value.includeAncestors,
      );
    });
    vecCandidates = scoped.length;
    // 按 distance 升序(越近越好)赋 RRF 名次
    const withDistance = scoped
      .map((row) => ({ row, distance: distanceOf.get(row._rowid as number)! }))
      .sort((a, b) => a.distance - b.distance);
    withDistance.forEach(({ row, distance }, i) => {
      const memory = rowToMemory(row as never);
      const existing = candidates.get(memory.id);
      if (existing) {
        existing.scores.vec = distance;
        existing.scores.rrf += rrfScore(i);
      } else {
        candidates.set(memory.id, { ...memory, scores: { vec: distance, rrf: rrfScore(i) } });
      }
    });
  }
  const tFuse = performance.now();

  // 阶段 2:RRF 已在融合中累加;按融合分排序后交给 rerank 钩子
  const fused = [...candidates.values()].sort((a, b) => b.scores.rrf - a.scores.rrf);
  const reranked = await reranker.rerank(value.query, fused);
  const tRerank = performance.now();

  return {
    results: reranked.slice(0, value.k),
    trace: {
      ftsCandidates,
      vecCandidates,
      fused: candidates.size,
      reranker: reranker.name,
      elapsedMs: {
        total: Math.round(tRerank - t0),
        recall: Math.round(tFuse - tRecall),
        fuse: Math.round(tFuse - tRecall),
        rerank: Math.round(tRerank - tFuse),
      },
    },
  };
}

function rrfScore(rank0: number): number {
  return 1 / (RRF_K + rank0 + 1);
}

const SENSITIVITY_RANK: Record<string, number> = { public: 0, normal: 1, sensitive: 2 };

function sensitivityAtMost(actual: string, max: string): boolean {
  return (SENSITIVITY_RANK[actual] ?? 2) <= (SENSITIVITY_RANK[max] ?? 1);
}

function matchesScope(
  row: { user: string; project: string | null; session: string | null },
  scope: Scope,
  includeAncestors: boolean,
): boolean {
  if (row.user !== scope.user) return false;
  return scopePairs(scope, includeAncestors).some(([p, s]) => row.project === p && row.session === s);
}

/** 用户查询 → 安全的 FTS5 MATCH 表达式:提取词元,逐个引号 + 前缀,OR 连接;零词元时跳过 FTS 路 */
function sanitizeMatchQuery(query: string): string {
  const lower = query.toLowerCase();
  const tokens = [...(lower.match(/[a-z0-9]+/g) ?? []), ...(lower.match(/[\u4e00-\u9fff\u3040-\u30ff]+/g) ?? [])];
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
