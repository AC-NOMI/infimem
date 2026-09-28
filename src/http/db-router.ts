import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

export interface DbRouterOptions {
  rootDir: string;
  provider: EmbeddingProvider;
  /** 同时保持打开的最大句柄数,超出按 LRU 逐出(关闭句柄,WAL 自动 checkpoint);默认 64 */
  maxOpen?: number;
}

/**
 * 按 user_id 分库路由(竞赛 G4):user_id 是官方契约的隔离边界,
 * 评测语义下 Search 永远带相同 user_id —— 每个 user 独立 SQLite 文件后,
 * 检索只扫该用户的记忆(数百条级),暴力 KNN 的全表扫描问题随之消失。
 *
 * 文件名 = sha256(user_id) 前 32 位十六进制:确定性、无路径逃逸、无需保存映射表。
 */
export class DbRouter {
  private readonly cache = new Map<string, Db>();

  constructor(private readonly opts: DbRouterOptions) {
    mkdirSync(opts.rootDir, { recursive: true });
  }

  get size(): number {
    return this.cache.size;
  }

  forUser(userId: string): Db {
    const key = createHash('sha256').update(userId).digest('hex').slice(0, 32);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached); // 刷新 LRU 位置
      return cached;
    }
    const db = openDb(join(this.opts.rootDir, `${key}.db`), { dim: this.opts.provider.dim });
    this.cache.set(key, db);
    this.evictIfNeeded(key);
    return db;
  }

  private evictIfNeeded(activeKey: string): void {
    const max = this.opts.maxOpen ?? 64;
    while (this.cache.size > max) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined || oldestKey === activeKey) break;
      const db = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (db) {
        try {
          db.close(); // close 时 WAL 自动 checkpoint 落盘
        } catch {
          // 已关闭的句柄忽略
        }
      }
    }
  }
}
