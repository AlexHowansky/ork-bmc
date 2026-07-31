/**
 * SQLite connection.
 *
 * One process, one connection, WAL mode. Every query in the app goes through
 * a prepared statement — parameters are never interpolated into SQL.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.ts';
import { log } from '../log.ts';

export function openDatabase(path: string = config.databasePath): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path, { create: true, readwrite: true });

  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  // NORMAL is the right trade-off under WAL: durable across process crashes,
  // and this app never has enough write volume to need FULL.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');

  return database;
}

export const db = openDatabase();

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 * Wraps `Database.transaction` so call sites read as plain functions.
 */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function closeDatabase(): void {
  db.close();
  log.debug('database closed');
}

export type { Database };
