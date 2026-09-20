import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDbPath,
  cmdInit,
  cmdAdd,
  cmdSearch,
  cmdForget,
  cmdCompact,
  cmdExport,
  cmdImport,
} from '../../src/cli/handlers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infimem-cli-'));
});
afterEach(() => {
  delete process.env.INFIMEM_DB;
});

describe('resolveDbPath', () => {
  it('prefers explicit --db over env over cwd default', () => {
    process.env.INFIMEM_DB = '/env/path.db';
    expect(resolveDbPath('/explicit/path.db')).toBe('/explicit/path.db');
    expect(resolveDbPath(undefined)).toBe('/env/path.db');
    delete process.env.INFIMEM_DB;
    expect(resolveDbPath(undefined)).toBe(join(process.cwd(), 'infimem.db'));
  });
});

describe('cli commands', () => {
  it('init creates a database file that opens cleanly twice', async () => {
    const dbPath = join(dir, 'a.db');
    await cmdInit(dbPath);
    await cmdInit(dbPath); // 幂等
    expect(existsSync(dbPath)).toBe(true);
  });

  it('add then search roundtrip through the file database', async () => {
    const dbPath = join(dir, 'b.db');
    await cmdInit(dbPath);
    const added = await cmdAdd(dbPath, {
      content: 'backend deploys use pnpm',
      type: 'preference',
      keywords: ['pnpm', 'deploy'],
      project: 'infimem',
    });
    expect(added.action).toBe('created');
    const found = await cmdSearch(dbPath, { query: 'pnpm', k: 5, project: 'infimem' });
    expect(found.results[0]!.content).toBe('backend deploys use pnpm');
  });

  it('forget by id and by canonical key', async () => {
    const dbPath = join(dir, 'c.db');
    await cmdInit(dbPath);
    const a = await cmdAdd(dbPath, { content: 'story one', canonicalKey: 'story' });
    const b = await cmdAdd(dbPath, { content: 'story two', canonicalKey: 'story', supersedes: a.id });
    const byId = await cmdForget(dbPath, { id: b.id });
    expect(byId.forgotten).toEqual([b.id]);
    const c = await cmdAdd(dbPath, { content: 'story three', canonicalKey: 'story' });
    const byKey = await cmdForget(dbPath, { canonicalKey: 'story', scope: { user: 'default' } });
    expect(byKey.forgotten).toEqual([c.id]);
  });

  it('compact reports without and with rebuild', async () => {
    const dbPath = join(dir, 'd.db');
    await cmdInit(dbPath);
    await cmdAdd(dbPath, { content: 'compact target note' });
    const plain = await cmdCompact(dbPath, {});
    expect(plain.indexRebuilt).toBe(false);
    const rebuilt = await cmdCompact(dbPath, { rebuildIndex: true });
    expect(rebuilt.indexRebuilt).toBe(true);
    expect(rebuilt.vecPendingAfter).toBe(0);
  });

  it('export then import roundtrips content and re-import is fully idempotent', async () => {
    const db1 = join(dir, 'e1.db');
    const db2 = join(dir, 'e2.db');
    await cmdInit(db1);
    await cmdInit(db2);
    const a = await cmdAdd(db1, { content: 'roundtrip fact one', keywords: ['alpha'] });
    await cmdAdd(db1, { content: 'roundtrip fact two', project: 'p1', supersedes: a.id, canonicalKey: 'rt' });
    await cmdAdd(db1, { content: 'roundtrip fact three' });

    const file = join(dir, 'dump.jsonl');
    const exported = await cmdExport(db1, file);
    expect(exported.count).toBe(3);

    const imported = await cmdImport(db2, file);
    expect(imported.created).toBe(2);
    expect(imported.skippedInactive).toBe(1);

    const again = await cmdImport(db2, file);
    expect(again.created).toBe(0);
    expect(again.duplicate).toBe(2);

    const out1 = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { content: string });
    expect(out1.map((r) => r.content).sort()).toEqual(
      ['roundtrip fact one', 'roundtrip fact two', 'roundtrip fact three'].sort(),
    );
    const found = await cmdSearch(db2, { query: 'roundtrip fact', k: 10 });
    expect(found.results.map((r) => r.content)).toContain('roundtrip fact three');
    const inProject = await cmdSearch(db2, { query: 'roundtrip fact', k: 10, project: 'p1' });
    expect(inProject.results.map((r) => r.content)).toContain('roundtrip fact two');
  });
});
