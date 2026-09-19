import type { MemoryType, Scope, Sensitivity, WriteSource } from './memory.js';

export type MemoryStatus = 'active' | 'superseded' | 'deleted';

/** memories 行的内存表示(字段名 camelCase,keywords 已解析) */
export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  keywords: string[];
  scope: Scope;
  sensitivity: Sensitivity;
  confidence: number;
  source: WriteSource;
  sourceRef: string | null;
  supersedes: string | null;
  status: MemoryStatus;
  vecPending: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  keywords: string;
  scope_user: string;
  scope_project: string | null;
  scope_session: string | null;
  sensitivity: string;
  confidence: number;
  source: string;
  source_ref: string | null;
  supersedes: string | null;
  status: string;
  vec_pending: number;
  created_at: string;
  updated_at: string;
}

export function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    keywords: JSON.parse(row.keywords) as string[],
    scope: {
      user: row.scope_user,
      ...(row.scope_project != null ? { project: row.scope_project } : {}),
      ...(row.scope_session != null ? { session: row.scope_session } : {}),
    },
    sensitivity: row.sensitivity as Sensitivity,
    confidence: row.confidence,
    source: row.source as WriteSource,
    sourceRef: row.source_ref,
    supersedes: row.supersedes,
    status: row.status as MemoryStatus,
    vecPending: row.vec_pending === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const MEMORY_COLUMNS =
  'memories.id, memories.type, memories.content, memories.keywords, memories.canonical_key, memories.scope_user, memories.scope_project, memories.scope_session, memories.sensitivity, memories.confidence, memories.source, memories.source_ref, memories.supersedes, memories.status, memories.vec_pending, memories.created_at, memories.updated_at';
