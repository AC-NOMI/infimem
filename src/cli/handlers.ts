import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../db/connection.js';
import { remember, type RememberResult } from '../ingest/ingest.js';
import { search } from '../retrieval/search.js';
import type { SearchOutput } from '../retrieval/types.js';
import { forget, type ForgetResult } from '../governance/forget.js';
import { compact, type CompactOptions, type CompactReport } from '../governance/compact.js';
import { getProviderFromEnv } from '../embeddings/env.js';
import type { RememberInput, Scope } from '../schema/memory.js';
import { InfimemError } from '../errors.js';

export function resolveDbPath(explicit?: string): string {
  return explicit ?? process.env.INFIMEM_DB ?? join(process.cwd(), 'infimem.db');
}

export async function cmdInit(dbPath: string): Promise<{ path: string }> {
  const db = openDb(dbPath, { dim: getProviderFromEnv().dim });
  db.close();
  return { path: dbPath };
}

export interface AddArgs {
  content: string;
  type?: RememberInput['type'];
  keywords?: string[];
  project?: string;
  session?: string;
  sensitivity?: RememberInput['sensitivity'];
  confidence?: number;
  canonicalKey?: string;
  sourceRef?: string;
  supersedes?: string;
  idempotencyKey?: string;
}

export async function cmdAdd(dbPath: string, args: AddArgs): Promise<RememberResult> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  try {
    return await remember(db, provider, {
      content: args.content,
      keywords: args.keywords ?? [],
      ...(args.type ? { type: args.type } : {}),
      scope: { project: args.project, session: args.session },
      ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      ...(args.canonicalKey ? { canonicalKey: args.canonicalKey } : {}),
      ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    });
  } finally {
    db.close();
  }
}

export interface SearchArgs {
  query: string;
  k?: number;
  project?: string;
  session?: string;
  includeAncestors?: boolean;
  maxSensitivity?: RememberInput['sensitivity'];
  type?: RememberInput['type'];
}

export async function cmdSearch(dbPath: string, args: SearchArgs): Promise<SearchOutput> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  try {
    return await search(db, provider, {
      query: args.query,
      ...(args.k ? { k: args.k } : {}),
      scope: { project: args.project, session: args.session },
      ...(args.includeAncestors !== undefined ? { includeAncestors: args.includeAncestors } : {}),
      ...(args.maxSensitivity ? { maxSensitivity: args.maxSensitivity } : {}),
      ...(args.type ? { type: args.type } : {}),
    });
  } finally {
    db.close();
  }
}

export interface ForgetArgs {
  id?: string;
  canonicalKey?: string;
  scope?: Scope;
}

export async function cmdForget(dbPath: string, args: ForgetArgs): Promise<ForgetResult> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  try {
    return await forget(db, {
      ...(args.id ? { id: args.id } : {}),
      ...(args.canonicalKey ? { canonicalKey: args.canonicalKey, scope: args.scope ?? { user: 'default' } } : {}),
    });
  } finally {
    db.close();
  }
}

export async function cmdCompact(dbPath: string, options: CompactOptions): Promise<CompactReport> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  try {
    return await compact(db, provider, options);
  } finally {
    db.close();
  }
}

// ---------- import / export ----------

interface ExportRow {
  id: string;
  type: string;
  content: string;
  keywords: string[];
  canonicalKey: string;
  scope: Scope;
  sensitivity: string;
  confidence: number;
  source: string;
  sourceRef: string | null;
  supersedes: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function cmdExport(dbPath: string, filePath: string): Promise<{ count: number }> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  try {
    const rows = db
      .prepare(
        `SELECT id, type, content, keywords, canonical_key, scope_user, scope_project, scope_session,
                sensitivity, confidence, source, source_ref, supersedes, status, created_at, updated_at
         FROM memories ORDER BY created_at, id`,
      )
      .all() as Record<string, unknown>[];
    const lines = rows.map((r): ExportRow => ({
      id: r.id as string,
      type: r.type as string,
      content: r.content as string,
      keywords: JSON.parse(r.keywords as string) as string[],
      canonicalKey: r.canonical_key as string,
      scope: {
        user: r.scope_user as string,
        ...((r.scope_project as string | null) != null ? { project: r.scope_project as string } : {}),
        ...((r.scope_session as string | null) != null ? { session: r.scope_session as string } : {}),
      },
      sensitivity: r.sensitivity as string,
      confidence: r.confidence as number,
      source: r.source as string,
      sourceRef: (r.source_ref as string | null) ?? null,
      supersedes: (r.supersedes as string | null) ?? null,
      status: r.status as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
    return { count: lines.length };
  } finally {
    db.close();
  }
}

export interface ImportResult {
  created: number;
  duplicate: number;
  skippedInactive: number;
  errors: number;
}

/**
 * 导入 = 重新摄取(非备份恢复):仅 active 行,幂等键用原 id,重复导入安全。
 * 字节级备份 = 直接复制 .db 文件(README 说明)。
 */
export async function cmdImport(dbPath: string, filePath: string): Promise<ImportResult> {
  const provider = getProviderFromEnv();
  const db = openDb(dbPath, { dim: provider.dim });
  const result: ImportResult = { created: 0, duplicate: 0, skippedInactive: 0, errors: 0 };
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      let row: ExportRow;
      try {
        row = JSON.parse(line) as ExportRow;
      } catch {
        result.errors++;
        continue;
      }
      if (row.status !== 'active') {
        result.skippedInactive++;
        continue;
      }
      // remember 的幂等重放会原样返回首次 action('created'),这里预查幂等表才能区分重复
      const seen = db.prepare('SELECT memory_id FROM idempotency_keys WHERE key = ?').get(row.id);
      if (seen) {
        result.duplicate++;
        continue;
      }
      const r = await remember(db, provider, {
        content: row.content,
        keywords: row.keywords ?? [],
        ...(row.type ? { type: row.type as RememberInput['type'] } : {}),
        scope: row.scope ?? { user: 'default' },
        ...(row.canonicalKey ? { canonicalKey: row.canonicalKey } : {}),
        ...(row.sensitivity ? { sensitivity: row.sensitivity as RememberInput['sensitivity'] } : {}),
        confidence: row.confidence,
        ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
        idempotencyKey: row.id,
      });
      if (r.action === 'created') result.created++;
      else if (r.action === 'duplicate') result.duplicate++;
      else result.created++;
    }
    return result;
  } finally {
    db.close();
  }
}

export { InfimemError };
