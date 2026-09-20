import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/connection.js';
import { getDbDim } from '../../src/db/meta.js';
import { makeDb } from '../helpers.js';

describe('openDb + migrate', () => {
  it('creates all tables and virtual tables', () => {
    const db = makeDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain('memories');
    expect(names).toContain('memories_fts');
    expect(names).toContain('memories_vec');
    expect(names).toContain('conflicts');
    expect(names).toContain('audit_events');
    expect(names).toContain('idempotency_keys');
    db.close();
  });

  it('is idempotent — re-opening an existing database keeps schema version and data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infimem-'));
    const file = join(dir, 'test.db');
    const first = openDb(file);
    first.exec(
      "INSERT INTO audit_events (ts, action, actor) VALUES ('2026-01-01', 'write', 'test')"
    );
    const second = openDb(file);
    const version = second.prepare('SELECT user_version AS v FROM pragma_user_version').get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(1);
    const audits = second.prepare('SELECT count(*) AS c FROM audit_events').get() as { c: number };
    expect(audits.c).toBe(1);
    first.close();
    second.close();
  });

  it('FTS5 triggers keep the index in sync with memories content', () => {
    const db = makeDb();
    db.exec(
      "INSERT INTO memories (id, type, content, content_hash, keywords, canonical_key, scope_user, source, created_at, updated_at) " +
        "VALUES ('m1', 'fact', 'deploy with pnpm not npm', 'h1', '[]', 'k1', 'default', 'cli', '2026-01-01', '2026-01-01')"
    );
    const countMatching = (term: string) =>
      (db.prepare('SELECT count(*) AS c FROM memories_fts WHERE memories_fts MATCH ?').get(term) as { c: number }).c;
    expect(countMatching('pnpm')).toBe(1);
    db.exec("UPDATE memories SET content = 'deploy with yarn not npm' WHERE id = 'm1'");
    expect(countMatching('pnpm')).toBe(0);
    expect(countMatching('yarn')).toBe(1);
    db.close();
  });

  it('memories_vec accepts a float[384] row with metadata backlink', () => {
    const db = makeDb();
    const vec = Buffer.from(new Float32Array(384).fill(0.5).buffer);
    db.prepare('INSERT INTO memories_vec(embedding, memory_rowid) VALUES (?, ?)').run(vec, 42n);
    const row = db.prepare('SELECT memory_rowid, vec_length(embedding) AS l FROM memories_vec').get() as {
      memory_rowid: number;
      l: number;
    };
    expect(row.memory_rowid).toBe(42);
    expect(row.l).toBe(384);
    db.close();
  });

  it('binds the vector dimension at creation and rejects mismatched reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infimem-dim-'));
    const file = join(dir, 'dim.db');
    const a = openDb(file, { dim: 8 });
    expect(getDbDim(a)).toBe(8);
    a.close();
    expect(() => openDb(file, { dim: 1536 })).toThrow(/dimension mismatch/);
    const b = openDb(file, { dim: 8 });
    expect(getDbDim(b)).toBe(8);
    b.close();
  });
});
