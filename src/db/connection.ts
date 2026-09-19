import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from './migrate.js';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  migrate(db);
  return db;
}
