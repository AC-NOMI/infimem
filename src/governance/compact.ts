import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { writeAudit } from './audit.js';

export interface CompactOptions {
  rebuildIndex?: boolean;
}

export interface CompactReport {
  memories: number;
  conflicts: number;
  chains: { depth1: number; maxDepth: number };
  vecPendingBefore: number;
  vecPendingAfter: number;
  indexRebuilt: boolean;
  durationMs: number;
}

interface CompactRow {
  id: string;
  content: string;
  keywords: string;
  status: string;
  vec_pending: number;
  rowid: number;
}

/**
 * 整理(见 FEATURES.md §3.4):报告版本链与冲突状况;rebuildIndex 时从 memories 表
 * 全量重建 FTS 与向量索引——索引是可重建的派生物(章程 §4.1),顺带补齐 vec_pending。
 */
export async function compact(db: Db, provider: EmbeddingProvider, options: CompactOptions = {}): Promise<CompactReport> {
  const t0 = performance.now();
  const rebuild = options.rebuildIndex ?? false;

  const stats = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM memories) AS memories,
         (SELECT count(*) FROM conflicts) AS conflicts,
         (SELECT count(*) FROM memories WHERE supersedes IS NOT NULL) AS depth1,
         (SELECT count(*) FROM memories WHERE vec_pending = 1) AS vec_pending`
    )
    .get() as { memories: number; conflicts: number; depth1: number; vec_pending: number };
  const maxDepth = computeMaxChainDepth(db);

  if (rebuild) {
    // embedding 在事务外批量计算,事务内只做写入
    const rows = db
      .prepare("SELECT rowid, id, content, keywords, status, vec_pending FROM memories WHERE status != 'deleted'")
      .all() as CompactRow[];
    const vectors = new Map<number, Float32Array>();
    for (const row of rows) {
      try {
        vectors.set(row.rowid, await provider.embed([row.content, row.keywords].join('\n')));
      } catch {
        // 该行保持 vec_pending
      }
    }

    db.transaction(() => {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
      db.exec('DELETE FROM memories_vec');
      const insertVec = db.prepare('INSERT INTO memories_vec(embedding, memory_rowid) VALUES (?, ?)');
      const setPending = db.prepare('UPDATE memories SET vec_pending = ? WHERE rowid = ?');
      for (const row of rows) {
        const vec = vectors.get(row.rowid);
        if (vec) {
          insertVec.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), BigInt(row.rowid));
          setPending.run(0, row.rowid);
        } else {
          setPending.run(1, row.rowid);
        }
      }
    })();
  }

  const after = db.prepare('SELECT count(*) AS c FROM memories WHERE vec_pending = 1').get() as { c: number };
  const durationMs = Math.round(performance.now() - t0);

  writeAudit(db, {
    action: 'compact',
    actor: 'mcp',
    detail: { rebuild_index: rebuild, memories: stats.memories, vec_pending_after: after.c },
  });

  return {
    memories: stats.memories,
    conflicts: stats.conflicts,
    chains: { depth1: stats.depth1, maxDepth },
    vecPendingBefore: stats.vec_pending,
    vecPendingAfter: after.c,
    indexRebuilt: rebuild,
    durationMs,
  };
}

function computeMaxChainDepth(db: Db): number {
  const links = db.prepare('SELECT id, supersedes FROM memories WHERE supersedes IS NOT NULL').all() as {
    id: string;
    supersedes: string;
  }[];
  const parentOf = new Map(links.map((l) => [l.id, l.supersedes]));
  let maxDepth = links.length > 0 ? 1 : 0;
  for (const link of links) {
    let depth = 1;
    let cur: string | undefined = link.supersedes;
    while (cur !== undefined) {
      cur = parentOf.get(cur);
      if (cur !== undefined) depth++;
    }
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}
