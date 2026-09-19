import { describe, expect, it, beforeEach } from 'vitest';
import { remember, type RememberInput } from '../../src/ingest/ingest.js';
import { search } from '../../src/retrieval/search.js';
import type { Scope } from '../../src/schema/memory.js';
import { makeDb, hashProvider, type Db } from '../helpers.js';

async function seed(db: Db, content: string, extra: Partial<RememberInput> = {}): Promise<string> {
  const r = await remember(db, hashProvider, { content, ...extra });
  return r.id;
}

const userScope: Scope = { user: 'default' };
const projScope: Scope = { user: 'default', project: 'infimem' };
const sessScope: Scope = { user: 'default', project: 'infimem', session: 's1' };

let db: Db;
beforeEach(async () => {
  db = makeDb();
  await seed(db, 'deploy backend with pnpm', { scope: userScope });
  await seed(db, 'deploy pipeline notes and rerank hook design', { scope: sessScope });
  await seed(db, 'secret api key stored in vault', { scope: projScope, sensitivity: 'sensitive' });
  await seed(db, 'deploy with docker compose', { scope: { user: 'default', project: 'other-app' } });
});

describe('search — scope resolution', () => {
  it('a session query with ancestors sees session, project and user memories', async () => {
    const r = await search(db, hashProvider, { query: 'deploy', scope: sessScope, k: 10 });
    const contents = r.results.map((x) => x.content);
    expect(contents).toContain('deploy pipeline notes and rerank hook design');
    expect(contents).toContain('deploy backend with pnpm');
    expect(contents).not.toContain('deploy with docker compose');
  });

  it('an exact scope query (no ancestors) excludes ancestor-level memories', async () => {
    const r = await search(db, hashProvider, {
      query: 'deploy',
      scope: sessScope,
      k: 10,
      includeAncestors: false,
    });
    const contents = r.results.map((x) => x.content);
    expect(contents).toContain('deploy pipeline notes and rerank hook design');
    expect(contents).not.toContain('deploy backend with pnpm');
  });

  it('never leaks memories across users', async () => {
    await seed(db, 'alice private note about wimbledon', { scope: { user: 'alice' } });
    const r = await search(db, hashProvider, { query: 'wimbledon', scope: { user: 'bob' } });
    expect(r.results).toHaveLength(0);
  });
});

describe('search — sensitivity gate', () => {
  it('excludes sensitive memories by default (max_sensitivity=normal)', async () => {
    const r = await search(db, hashProvider, { query: 'api key vault', scope: projScope, k: 10 });
    expect(r.results.map((x) => x.content)).not.toContain('secret api key stored in vault');
  });

  it('returns sensitive memories when max_sensitivity=sensitive', async () => {
    const r = await search(db, hashProvider, {
      query: 'api key vault',
      scope: projScope,
      k: 10,
      maxSensitivity: 'sensitive',
    });
    expect(r.results.map((x) => x.content)).toContain('secret api key stored in vault');
  });
});

describe('search — fusion, ranking, transparency', () => {
  it('ranks the keyword hit first and exposes per-stage scores', async () => {
    const r = await search(db, hashProvider, { query: 'pnpm', scope: userScope, k: 5 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.content).toBe('deploy backend with pnpm');
    expect(r.results[0]!.scores.rrf).toBeGreaterThan(0);
    expect(r.results[0]!.scores.fts).toBeDefined();
    expect(r.results[0]!.scores.vec).toBeDefined();
  });

  it('caps results at k', async () => {
    for (let i = 0; i < 6; i++) await seed(db, `sqlite performance note ${i}`, { scope: projScope });
    const r = await search(db, hashProvider, { query: 'sqlite performance note', scope: projScope, k: 3 });
    expect(r.results).toHaveLength(3);
  });

  it('returns only active memories (superseded versions invisible)', async () => {
    const old = await seed(db, 'team uses npm scripts', { scope: projScope });
    await remember(db, hashProvider, {
      content: 'team uses pnpm scripts now',
      scope: projScope,
      supersedes: old,
    });
    const r = await search(db, hashProvider, { query: 'npm scripts', scope: projScope, k: 10 });
    expect(r.results.map((x) => x.content)).not.toContain('team uses npm scripts');
  });

  it('attaches a pipeline trace with candidate counts and timings', async () => {
    const r = await search(db, hashProvider, { query: 'pnpm', scope: userScope });
    expect(r.trace).toMatchObject({ fused: r.results.length });
    expect(r.trace.ftsCandidates).toBeGreaterThanOrEqual(0);
    expect(r.trace.vecCandidates).toBeGreaterThanOrEqual(0);
    expect(r.trace.elapsedMs.total).toBeGreaterThanOrEqual(0);
  });

  it('survives FTS5 syntax characters in the query without crashing', async () => {
    const r = await search(db, hashProvider, { query: 'pnpm" OR NOT (deploy) AND NEAR(' });
    expect(r.results).toBeDefined();
  });

  it('returns empty results on an unknown topic with no error', async () => {
    const r = await search(db, hashProvider, { query: 'quantum underwater basket weaving' });
    expect(r.results).toEqual([]);
  });

  it('filters by memory type when requested', async () => {
    await seed(db, 'preference for dark mode editors', { scope: projScope, type: 'preference' });
    const r = await search(db, hashProvider, {
      query: 'dark mode editors',
      scope: projScope,
      type: 'fact',
      k: 10,
    });
    expect(r.results.map((x) => x.content)).not.toContain('preference for dark mode editors');
  });
});
