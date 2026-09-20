import type Database from 'better-sqlite3';
import { InfimemError } from '../errors.js';

/**
 * 迁移按序号推进,PRAGMA user_version 记录已应用版本。
 * 新增迁移只能追加,不能修改历史条目。
 * v0.1 尚未发布,001 保持可编辑;发布后冻结。
 */

// 001 — 初始 schema:正文表 + 可重建的派生索引(FTS/向量)+ 治理表
// 维度在建库时确定并写入 infimem_meta;vec0 表无法 ALTER 维度,v0.1 每库绑定一个 provider 维度
function m001(dim: number): string {
  return `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'event', 'procedure')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  canonical_key TEXT NOT NULL,
  scope_user TEXT NOT NULL,
  scope_project TEXT,
  scope_session TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('public', 'normal', 'sensitive')),
  confidence REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL,
  source_ref TEXT,
  supersedes TEXT REFERENCES memories(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
  vec_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memories_scope ON memories (scope_user, scope_project, scope_session, status);
CREATE INDEX idx_memories_canonical_key ON memories (canonical_key, status);
CREATE INDEX idx_memories_supersedes ON memories (supersedes);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  keywords,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
END;
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
END;
CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
END;

-- sqlite-vec 0.1.9 的显式 rowid 插入路径有 bug:一律走 metadata 列 memory_rowid 回链 memories.rowid
-- 距离度量显式用余弦(vec0 默认是 L2):maxDistance 截断与"不相关 ≈ 1.0"的语义都按余弦设计
CREATE VIRTUAL TABLE memories_vec USING vec0(
  embedding float[${dim}] distance_metric=cosine,
  memory_rowid integer metadata
);

CREATE TABLE conflicts (
  a_id TEXT NOT NULL REFERENCES memories(id),
  b_id TEXT NOT NULL REFERENCES memories(id),
  created_at TEXT NOT NULL,
  UNIQUE (a_id, b_id)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('write', 'supersede', 'forget', 'compact', 'purge')),
  memory_id TEXT,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE infimem_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
}

export const DEFAULT_DIM = 384;

export function migrate(db: Database.Database, dim: number = DEFAULT_DIM): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current === 0) {
    db.exec(m001(dim));
    db.prepare("INSERT INTO infimem_meta (key, value) VALUES ('dimension', ?)").run(String(dim));
    db.pragma('user_version = 1');
    return;
  }
  // 已存在的库:维度必须与请求一致(v0.1 不做跨维度重建)
  const stored = db.prepare("SELECT value FROM infimem_meta WHERE key = 'dimension'").get() as
    | { value: string }
    | undefined;
  if (stored && Number(stored.value) !== dim) {
    throw new InfimemError(
      `embedding dimension mismatch: database was created with dim=${stored.value}, requested dim=${dim}. ` +
        'v0.1 keeps one database file per provider; create a new database or reopen with the matching provider.',
    );
  }
}
