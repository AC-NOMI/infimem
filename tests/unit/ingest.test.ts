import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { remember } from '../../src/ingest/ingest.js';
import { ValidationError, NotFoundError } from '../../src/errors.js';
import { makeDb, hashProvider, fixedProvider, brokenProvider } from '../helpers.js';
import type { Db } from '../../src/db/connection.js';

function rowCount(db: Db, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { c: number }).c;
}

describe('remember — created path', () => {
  it('stores a memory and returns created with an id', async () => {
    const db = makeDb();
    const result = await remember(db, hashProvider, { content: 'deploy backend with pnpm' });
    expect(result.action).toBe('created');
    expect(result.id).toBeDefined();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      type: 'fact',
      content: 'deploy backend with pnpm',
      status: 'active',
      sensitivity: 'normal',
      vec_pending: 0,
      scope_user: 'default',
      source: 'mcp',
    });
    db.close();
  });

  it('writes keywords and custom fields through to the row', async () => {
    const db = makeDb();
    const result = await remember(db, hashProvider, {
      content: 'prefers pnpm for installs',
      type: 'preference',
      keywords: ['pnpm', 'package-manager'],
      scope: { project: 'infimem', session: 's-1' },
      sensitivity: 'sensitive',
      confidence: 0.95,
      sourceRef: 'https://example.com/notes',
    });
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      type: 'preference',
      sensitivity: 'sensitive',
      confidence: 0.95,
      scope_project: 'infimem',
      scope_session: 's-1',
      source_ref: 'https://example.com/notes',
    });
    expect(JSON.parse(row.keywords as string)).toEqual(['pnpm', 'package-manager']);
    db.close();
  });

  it('inserts a matching FTS row via trigger and a vector row backlinked by memories.rowid', async () => {
    const db = makeDb();
    const result = await remember(db, fixedProvider(), { content: 'deploy backend with pnpm' });
    expect(rowCount(db, "SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH 'pnpm'")).toBe(1);
    const memRowid = (db.prepare('SELECT rowid r FROM memories WHERE id = ?').get(result.id) as { r: number }).r;
    const vecRow = db.prepare('SELECT memory_rowid FROM memories_vec WHERE memory_rowid = ?').get(BigInt(memRowid)) as
      | { memory_rowid: number }
      | undefined;
    expect(vecRow).toBeDefined();
    expect(vecRow!.memory_rowid).toBe(memRowid);
    db.close();
  });

  it('writes an audit event with action write and detail that does not contain the content', async () => {
    const db = makeDb();
    await remember(db, hashProvider, { content: 'secret plan for q4 roadmap' });
    const event = db.prepare("SELECT * FROM audit_events WHERE action = 'write'").get() as Record<string, unknown>;
    expect(event).toBeDefined();
    expect(String(event.detail)).not.toContain('secret plan');
    db.close();
  });
});

describe('remember — validation', () => {
  it.each([
    ['empty content', { content: '' }],
    ['whitespace-only content', { content: '   ' }],
    ['content over 2000 chars', { content: 'x'.repeat(2001) }],
    ['unknown type', { content: 'ok', type: 'gossip' }],
    ['unknown sensitivity', { content: 'ok', sensitivity: 'top-secret' }],
    ['confidence out of range', { content: 'ok', confidence: 1.5 }],
    ['keywords not strings', { content: 'ok', keywords: [1, 2] }],
  ])('rejects %s with ValidationError', async (_label, input) => {
    const db = makeDb();
    await expect(remember(db, hashProvider, input)).rejects.toBeInstanceOf(ValidationError);
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(0);
    db.close();
  });
});

describe('remember — idempotency', () => {
  it('returns the first result verbatim for a repeated idempotency key without writing again', async () => {
    const db = makeDb();
    const key = randomUUID();
    const first = await remember(db, hashProvider, { content: 'user prefers pnpm', idempotencyKey: key });
    const second = await remember(db, hashProvider, { content: 'totally different text', idempotencyKey: key });
    expect(second).toEqual(first);
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(1);
    db.close();
  });
});

describe('remember — dedup', () => {
  it('reports duplicate for same canonical key and same content, writing nothing', async () => {
    const db = makeDb();
    const first = await remember(db, hashProvider, { content: 'deploy with pnpm', canonicalKey: 'deploy-tool' });
    const second = await remember(db, hashProvider, { content: 'deploy with pnpm', canonicalKey: 'deploy-tool' });
    expect(second.action).toBe('duplicate');
    expect(second.id).toBe(first.id);
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(1);
    // duplicate 是 no-op:不产生审计
    expect(rowCount(db, "SELECT count(*) c FROM audit_events WHERE action = 'write'")).toBe(1);
    db.close();
  });

  it('auto-generated canonical key treats whitespace/case variants as duplicates', async () => {
    const db = makeDb();
    await remember(db, hashProvider, { content: 'Deploy  with PNPM' });
    const second = await remember(db, hashProvider, { content: 'deploy with pnpm' });
    expect(second.action).toBe('duplicate');
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(1);
    db.close();
  });

  it('same content under different scopes is NOT a duplicate', async () => {
    const db = makeDb();
    await remember(db, hashProvider, { content: 'release on friday', scope: { project: 'a' } });
    const second = await remember(db, hashProvider, { content: 'release on friday', scope: { project: 'b' } });
    expect(second.action).toBe('created');
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(2);
    db.close();
  });
});

describe('remember — supersedes', () => {
  it('replaces an active version: old becomes superseded, new is active and linked', async () => {
    const db = makeDb();
    const old = await remember(db, hashProvider, { content: 'deploy with npm v1', canonicalKey: 'deploy-tool' });
    const next = await remember(db, hashProvider, {
      content: 'deploy with pnpm v2',
      canonicalKey: 'deploy-tool',
      supersedes: old.id,
    });
    expect(next.action).toBe('superseded');
    expect(next.supersededId).toBe(old.id);
    const oldRow = db.prepare('SELECT status FROM memories WHERE id = ?').get(old.id) as { status: string };
    const newRow = db.prepare('SELECT status, supersedes FROM memories WHERE id = ?').get(next.id) as {
      status: string;
      supersedes: string;
    };
    expect(oldRow.status).toBe('superseded');
    expect(newRow.status).toBe('active');
    expect(newRow.supersedes).toBe(old.id);
    db.close();
  });

  it('writes a supersede audit event', async () => {
    const db = makeDb();
    const old = await remember(db, hashProvider, { content: 'old fact' });
    await remember(db, hashProvider, { content: 'new fact', supersedes: old.id });
    expect(rowCount(db, "SELECT count(*) c FROM audit_events WHERE action = 'supersede'")).toBe(1);
    db.close();
  });

  it('rejects supersedes pointing at a missing memory with NotFoundError', async () => {
    const db = makeDb();
    await expect(
      remember(db, hashProvider, { content: 'new fact', supersedes: 'does-not-exist' })
    ).rejects.toBeInstanceOf(NotFoundError);
    db.close();
  });

  it('rejects supersedes pointing at a non-active memory', async () => {
    const db = makeDb();
    const v1 = await remember(db, hashProvider, { content: 'v1' });
    const v2 = await remember(db, hashProvider, { content: 'v2', supersedes: v1.id });
    await expect(
      remember(db, hashProvider, { content: 'v3', supersedes: v1.id })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rowCount(db, 'SELECT count(*) c FROM memories')).toBe(2);
    void v2;
    db.close();
  });
});

describe('remember — conflict isolation', () => {
  it('keeps both active rows when canonical key matches but content differs, and records the conflict', async () => {
    const db = makeDb();
    const a = await remember(db, hashProvider, { content: 'release day is friday', canonicalKey: 'release-day' });
    const b = await remember(db, hashProvider, { content: 'release day is monday', canonicalKey: 'release-day' });
    expect(b.action).toBe('conflict');
    expect(b.conflictWith).toEqual([a.id]);
    const statuses = db.prepare('SELECT status FROM memories WHERE canonical_key = ?').all('release-day') as {
      status: string;
    }[];
    expect(statuses.map((r) => r.status)).toEqual(['active', 'active']);
    expect(rowCount(db, 'SELECT count(*) c FROM conflicts')).toBe(1);
    db.close();
  });

  it('records a conflict pair against every existing active version', async () => {
    const db = makeDb();
    await remember(db, hashProvider, { content: 'story one', canonicalKey: 'story' });
    await remember(db, hashProvider, { content: 'story two', canonicalKey: 'story' });
    const third = await remember(db, hashProvider, { content: 'story three', canonicalKey: 'story' });
    expect(third.conflictWith).toHaveLength(2);
    expect(rowCount(db, 'SELECT count(*) c FROM conflicts')).toBe(3);
    db.close();
  });

  it('does not flag conflict against superseded (inactive) versions', async () => {
    const db = makeDb();
    const v1 = await remember(db, hashProvider, { content: 'team uses npm', canonicalKey: 'pkg-manager' });
    await remember(db, hashProvider, { content: 'team uses pnpm now', canonicalKey: 'pkg-manager', supersedes: v1.id });
    const conflict = await remember(db, hashProvider, { content: 'team uses yarn', canonicalKey: 'pkg-manager' });
    expect(conflict.conflictWith).toHaveLength(1);
    const conflicting = db.prepare('SELECT b_id FROM conflicts').all() as { b_id: string }[];
    expect(conflicting[0].b_id).not.toBe(v1.id);
    db.close();
  });
});

describe('remember — embedding degradation', () => {
  it('stores the memory with vec_pending when the provider fails, and notes it in audit', async () => {
    const db = makeDb();
    const result = await remember(db, brokenProvider(), { content: 'memory without vector' });
    expect(result.action).toBe('created');
    const row = db.prepare('SELECT vec_pending FROM memories WHERE id = ?').get(result.id) as { vec_pending: number };
    expect(row.vec_pending).toBe(1);
    expect(rowCount(db, 'SELECT count(*) c FROM memories_vec')).toBe(0);
    const detail = (
      db.prepare("SELECT detail FROM audit_events WHERE action = 'write'").get() as { detail: string }
    ).detail;
    expect(JSON.parse(detail)).toMatchObject({ vec_pending: true });
    db.close();
  });
});
