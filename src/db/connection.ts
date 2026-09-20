import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrate, DEFAULT_DIM } from './migrate.js';

export type Db = Database.Database;

export function openDb(path: string, opts: { dim?: number } = {}): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  migrate(db, opts.dim ?? DEFAULT_DIM);
  return db;
}
