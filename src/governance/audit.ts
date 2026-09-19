import type { Db } from '../db/connection.js';

export type AuditAction = 'write' | 'supersede' | 'forget' | 'compact' | 'purge';

export interface AuditEvent {
  action: AuditAction;
  actor: string;
  memoryId?: string;
  /** 只存变更摘要,绝不含正文——审计日志可能被单独导出 */
  detail?: Record<string, unknown>;
}

export function writeAudit(db: Db, event: AuditEvent): void {
  db.prepare('INSERT INTO audit_events (ts, action, memory_id, actor, detail) VALUES (?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    event.action,
    event.memoryId ?? null,
    event.actor,
    JSON.stringify(event.detail ?? {}),
  );
}
