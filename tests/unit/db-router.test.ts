import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbRouter } from '../../src/http/db-router.js';
import { remember } from '../../src/ingest/ingest.js';
import { search } from '../../src/retrieval/search.js';
import { hashProvider } from '../helpers.js';

function makeRouter(maxOpen?: number) {
  const rootDir = mkdtempSync(join(tmpdir(), 'infimem-shard-'));
  const router = new DbRouter({ rootDir, provider: hashProvider, ...(maxOpen ? { maxOpen } : {}) });
  return { rootDir, router };
}

describe('DbRouter(按 user_id 分库)', () => {
  it('same user returns the same cached handle', () => {
    const { router } = makeRouter();
    const a = router.forUser('eval:run1:conv-0');
    const b = router.forUser('eval:run1:conv-0');
    expect(b).toBe(a);
  });

  it('different users get isolated databases (write in one, invisible in the other)', async () => {
    const { router } = makeRouter();
    const db1 = router.forUser('user-1');
    await remember(db1, hashProvider, { content: 'secret of user one', scope: { user: 'user-1' } });

    const db2 = router.forUser('user-2');
    const out = await search(db2, hashProvider, { query: 'secret of user one', k: 5 });
    expect(out.results).toEqual([]);

    const back = await search(db1, hashProvider, { query: 'secret of user one', k: 5, scope: { user: 'user-1' } });
    expect(back.results[0]!.content).toBe('secret of user one');
  });

  it('persists data across LRU eviction and reopen', async () => {
    const { router } = makeRouter(2);
    const db1 = router.forUser('u1');
    await remember(db1, hashProvider, { content: 'survives eviction', scope: { user: 'u1' } });

    router.forUser('u2');
    router.forUser('u3'); // u1 被逐出并关闭
    expect(db1.open).toBe(false);

    const reopened = router.forUser('u1');
    expect(reopened.open).toBe(true);
    expect(reopened).not.toBe(db1); // 新句柄
    const out = await search(reopened, hashProvider, { query: 'survives eviction', k: 5, scope: { user: 'u1' } });
    expect(out.results[0]!.content).toBe('survives eviction');
  });

  it('uses hash filenames so hostile user_ids cannot escape the shard directory', () => {
    const { rootDir, router } = makeRouter();
    router.forUser('../../evil/../../etc/passwd');
    router.forUser('a:b:c:d:::');
    const dbs = readdirSync(rootDir).filter(f => /^[0-9a-f]{32}\.db$/.test(f));
    expect(dbs.length).toBe(2); // -wal/-shm 伴生文件不计
  });
});
