import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { contentHash, autoCanonicalKey } from '../schema/keys.js';
import { rememberInputSchema, scopeSchema, type RememberInput, type Scope } from '../schema/memory.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { writeAudit } from '../governance/audit.js';

export type RememberAction = 'created' | 'duplicate' | 'superseded' | 'conflict';

export interface RememberResult {
  id: string;
  action: RememberAction;
  supersededId?: string;
  conflictWith?: string[];
}

/**
 * 写入管线(见 FEATURES.md §4):
 * 校验 → 幂等 → canonical_key → 重复检测 → supersedes/冲突裁决 → 原子提交 → 审计。
 * embedding 在事务外计算:失败不拒绝写入,降级为 vec_pending。
 */
export async function remember(db: Db, provider: EmbeddingProvider, input: unknown): Promise<RememberResult> {
  const parsed = rememberInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('invalid remember input', parsed.error.issues);
  }
  const value: RememberInput = parsed.data;
  const scope: Scope = scopeSchema.parse(value.scope ?? {});

  let vector: Float32Array | null = null;
  try {
    vector = await provider.embed([value.content, ...value.keywords].join('\n'));
  } catch {
    vector = null;
  }

  const canonicalKey = value.canonicalKey?.trim() || autoCanonicalKey(value.type, value.content);
  const hash = contentHash(value.content);

  return db.transaction((): RememberResult => {
    const now = new Date().toISOString();

    if (value.idempotencyKey) {
      const hit = db
        .prepare('SELECT memory_id, action FROM idempotency_keys WHERE key = ?')
        .get(value.idempotencyKey) as { memory_id: string; action: RememberAction } | undefined;
      if (hit) return { id: hit.memory_id, action: hit.action };
    }

    // canonical_key 的唯一性按作用域路径判定:不同 project/session 的同文本不是重复
    const duplicate = db
      .prepare(
        `SELECT id FROM memories
         WHERE canonical_key = ? AND content_hash = ? AND status = 'active'
           AND scope_user IS ? AND scope_project IS ? AND scope_session IS ?
         LIMIT 1`
      )
      .get(
        canonicalKey,
        hash,
        scope.user,
        scope.project ?? null,
        scope.session ?? null,
      ) as { id: string } | undefined;
    if (duplicate) {
      recordIdempotency(db, value, duplicate.id, 'duplicate', now);
      return { id: duplicate.id, action: 'duplicate' };
    }

    let supersededId: string | undefined;
    if (value.supersedes) {
      const target = db.prepare('SELECT id, status FROM memories WHERE id = ?').get(value.supersedes) as
        | { id: string; status: string }
        | undefined;
      if (!target) throw new NotFoundError(`supersedes target not found: ${value.supersedes}`);
      if (target.status !== 'active') {
        throw new ValidationError(`supersedes target is not active: ${target.id}`);
      }
      db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, target.id);
      supersededId = target.id;
    }

    const others = db
      .prepare(
        `SELECT id FROM memories
         WHERE canonical_key = ? AND status = 'active'
           AND scope_user IS ? AND scope_project IS ? AND scope_session IS ?`
      )
      .all(
        canonicalKey,
        scope.user,
        scope.project ?? null,
        scope.session ?? null,
      ) as { id: string }[];
    const conflictWith = others.map((o) => o.id);
    const action: RememberAction = supersededId ? 'superseded' : conflictWith.length > 0 ? 'conflict' : 'created';

    const id = randomUUID();
    const info = db
      .prepare(
        `INSERT INTO memories (
           id, type, content, content_hash, keywords, canonical_key,
           scope_user, scope_project, scope_session,
           sensitivity, confidence, source, source_ref,
           supersedes, status, vec_pending, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        id,
        value.type,
        value.content,
        hash,
        JSON.stringify(value.keywords),
        canonicalKey,
        scope.user,
        scope.project ?? null,
        scope.session ?? null,
        value.sensitivity,
        value.confidence,
        value.source,
        value.sourceRef ?? null,
        supersededId ?? null,
        vector ? 0 : 1,
        now,
        now,
      );

    if (vector) {
      db.prepare('INSERT INTO memories_vec(embedding, memory_rowid) VALUES (?, ?)').run(
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        BigInt(info.lastInsertRowid),
      );
    }
    for (const other of conflictWith) {
      db.prepare('INSERT INTO conflicts (a_id, b_id, created_at) VALUES (?, ?, ?)').run(id, other, now);
    }

    writeAudit(db, {
      action: supersededId ? 'supersede' : 'write',
      memoryId: id,
      actor: value.source,
      detail: {
        canonical_key: canonicalKey,
        superseded_id: supersededId,
        conflicts: conflictWith.length,
        vec_pending: !vector,
      },
    });

    recordIdempotency(db, value, id, action, now);

    return {
      id,
      action,
      ...(supersededId ? { supersededId } : {}),
      ...(conflictWith.length > 0 ? { conflictWith } : {}),
    };
  })();
}

function recordIdempotency(db: Db, value: RememberInput, memoryId: string, action: RememberAction, now: string): void {
  if (!value.idempotencyKey) return;
  db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, memory_id, action, created_at) VALUES (?, ?, ?, ?)').run(
    value.idempotencyKey,
    memoryId,
    action,
    now,
  );
}
