import type { Db } from './connection.js';
import { DEFAULT_DIM } from './migrate.js';

/** 读取建库时确定的向量维度(infimem_meta.dimension) */
export function getDbDim(db: Db): number {
  const row = db.prepare("SELECT value FROM infimem_meta WHERE key = 'dimension'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : DEFAULT_DIM;
}
