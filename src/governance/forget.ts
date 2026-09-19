import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { scopeSchema } from '../schema/memory.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { writeAudit } from './audit.js';

export const forgetInputSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ canonicalKey: z.string().min(1).max(256), scope: scopeSchema }),
]);

export interface ForgetResult {
  forgotten: string[];
}

/**
 * 遗忘(见 FEATURES.md §3.3):仅作用于 active 记忆;tombstone(soft delete)+ 审计,
 * 并同步从 FTS 与向量索引移除。物理清除留给 v0.2 的导出后清除流。
 */
export async function forget(db: Db, input: unknown): Promise<ForgetResult> {
  const parsed = forgetInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('invalid forget input', parsed.error.issues);
  const value = parsed.data;

  return db.transaction((): ForgetResult => {
    const now = new Date().toISOString();
    let ids: string[];

    if ('id' in value) {
      const row = db
        .prepare("SELECT id FROM memories WHERE id = ? AND status = 'active'")
        .get(value.id) as { id: string } | undefined;
      if (!row) throw new NotFoundError(`no active memory with id: ${value.id}`);
      ids = [row.id];
    } else {
      const rows = db
        .prepare(
          `SELECT id FROM memories
           WHERE canonical_key = ? AND status = 'active'
             AND scope_user IS ? AND scope_project IS ? AND scope_session IS ?`
        )
        .all(value.canonicalKey, value.scope.user, value.scope.project ?? null, value.scope.session ?? null) as {
        id: string;
      }[];
      if (rows.length === 0) {
        throw new NotFoundError(`no active memory with canonical key: ${value.canonicalKey}`);
      }
      ids = rows.map((r) => r.id);
    }

    for (const id of ids) {
      const row = db.prepare('SELECT rowid AS r, content, keywords FROM memories WHERE id = ?').get(id) as {
        r: number;
        content: string;
        keywords: string;
      };
      db.prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id);
      // UPDATE 会触发 AU 触发器重新写入 FTS,这里再显式删除;向量索引按 metadata 回链删除
      db.prepare("INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', ?, ?, ?)").run(
        row.r,
        row.content,
        row.keywords,
      );
      db.prepare('DELETE FROM memories_vec WHERE memory_rowid = ?').run(BigInt(row.r));
      writeAudit(db, {
        action: 'forget',
        memoryId: id,
        actor: 'mcp',
        detail: { canonical_key: 'canonicalKey' in value ? value.canonicalKey : undefined },
      });
    }

    return { forgotten: ids };
  })();
}
