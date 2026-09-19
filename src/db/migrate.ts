import type Database from 'better-sqlite3';

/**
 * 迁移按序号排列,PRAGMA user_version 记录已应用到的版本。
 * 新增迁移只能追加,不能修改历史条目。
 */

// 001 — 初始 schema:正文表 + 可重建的派生索引(FTS/向量)+ 治理表
const M001_INITIAL = `
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
CREATE VIRTUAL TABLE memories_vec USING vec0(
  embedding float[384],
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
`;

const MIGRATIONS: readonly string[] = [M001_INITIAL];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${v + 1}`);
  }
}
