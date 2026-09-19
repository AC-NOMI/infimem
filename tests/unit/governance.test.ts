import { describe, expect, it, beforeEach } from 'vitest';
import { remember } from '../../src/ingest/ingest.js';
import { forget } from '../../src/governance/forget.js';
import { compact } from '../../src/governance/compact.js';
import { NotFoundError } from '../../src/errors.js';
import { makeDb, hashProvider, brokenProvider, type Db } from '../helpers.js';

let db: Db;
beforeEach(() => {
  db = makeDb();
});

describe('forget', () => {
  it('tombstones an active memory and removes it from FTS and vector index', async () => {
    const r = await remember(db, hashProvider, { content: 'temporary note about chromium flags' });
    const result = await forget(db, { id: r.id });
    expect(result.forgotten).toEqual([r.id]);
    const row = db.prepare('SELECT status FROM memories WHERE id = ?').get(r.id) as { status: string };
    expect(row.status).toBe('deleted');
    const memRowid = (db.prepare('SELECT rowid AS r FROM memories WHERE id = ?').get(r.id) as { r: number }).r;
    expect(
      (db.prepare('SELECT count(*) AS c FROM memories_vec WHERE memory_rowid = ?').get(BigInt(memRowid)) as { c: number }).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT count(*) AS c FROM memories_fts WHERE memories_fts MATCH 'chromium'").get() as { c: number }).c
    ).toBe(0);
  });

  it('writes a forget audit event', async () => {
    const r = await remember(db, hashProvider, { content: 'note to remove' });
    await forget(db, { id: r.id });
    const ev = db.prepare("SELECT memory_id FROM audit_events WHERE action = 'forget'").get() as { memory_id: string };
    expect(ev.memory_id).toBe(r.id);
  });

  it('raises NotFoundError for an unknown id', async () => {
    await expect(forget(db, { id: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to forget an already-deleted memory', async () => {
    const r = await remember(db, hashProvider, { content: 'gone soon' });
    await forget(db, { id: r.id });
    await expect(forget(db, { id: r.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forgets every active version sharing a canonical key within a scope, leaving tombstones of others untouched', async () => {
    const a = await remember(db, hashProvider, { content: 'story version one', canonicalKey: 'story' });
    const b = await remember(db, hashProvider, {
      content: 'story version two',
      canonicalKey: 'story',
      supersedes: a.id,
    });
    const c = await remember(db, hashProvider, { content: 'story version three', canonicalKey: 'story' });
    const result = await forget(db, { canonicalKey: 'story', scope: { user: 'default' } });
    expect([...result.forgotten].sort()).toEqual([b.id, c.id].sort());
    const aRow = db.prepare('SELECT status FROM memories WHERE id = ?').get(a.id) as { status: string };
    expect(aRow.status).toBe('superseded');
  });
});

describe('compact', () => {
  it('reports counts without changing data when rebuildIndex is false', async () => {
    const a = await remember(db, hashProvider, { content: 'compact probe one' });
    await remember(db, hashProvider, { content: 'compact probe two', supersedes: a.id });
    const report = await compact(db, hashProvider, {});
    expect(report.indexRebuilt).toBe(false);
    expect(report.memories).toBe(2);
    expect(report.chains.depth1).toBe(1);
    const before = (db.prepare('SELECT count(*) AS c FROM memories_vec').get() as { c: number }).c;
    expect(before).toBeGreaterThan(0);
  });

  it('rebuilds indexes from the memories table and clears vec_pending', async () => {
    const r = await remember(db, brokenProvider(), { content: 'memory stuck without vector' });
    expect((db.prepare('SELECT count(*) AS c FROM memories_vec').get() as { c: number }).c).toBe(0);
    const report = await compact(db, hashProvider, { rebuildIndex: true });
    expect(report.indexRebuilt).toBe(true);
    const row = db.prepare('SELECT vec_pending FROM memories WHERE id = ?').get(r.id) as { vec_pending: number };
    expect(row.vec_pending).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM memories_vec').get() as { c: number }).c).toBe(1);
  });

  it('restores searchability after the FTS index is wiped', async () => {
    await remember(db, hashProvider, { content: 'recoverable fact about otters' });
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('delete-all')");
    const empty = db.prepare("SELECT count(*) AS c FROM memories_fts WHERE memories_fts MATCH 'otters'").get() as {
      c: number;
    };
    expect(empty.c).toBe(0);
    await compact(db, hashProvider, { rebuildIndex: true });
    const restored = db.prepare("SELECT count(*) AS c FROM memories_fts WHERE memories_fts MATCH 'otters'").get() as {
      c: number;
    };
    expect(restored.c).toBe(1);
  });

  it('writes a compact audit event', async () => {
    await compact(db, hashProvider, { rebuildIndex: true });
    expect((db.prepare("SELECT count(*) AS c FROM audit_events WHERE action = 'compact'").get() as { c: number }).c).toBe(1);
  });
});
