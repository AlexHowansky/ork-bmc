/**
 * Forward-only schema migrations, tracked with SQLite's `user_version`.
 *
 * Files in ./migrations are named `NNN_description.sql`; each runs exactly once,
 * in numeric order, inside a transaction. Run directly (`bun run db:migrate`)
 * or call `migrate(db)` from the server and tests.
 */
import type { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.ts';
import { db as defaultDb } from './index.ts';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');
const FILENAME_PATTERN = /^(\d+)_[\w-]+\.sql$/;

interface Migration {
  version: number;
  filename: string;
  path: string;
}

function discoverMigrations(): Migration[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = FILENAME_PATTERN.exec(filename);
      if (!match?.[1]) {
        throw new Error(`Migration "${filename}" must be named like 001_description.sql`);
      }
      return { version: Number(match[1]), filename, path: join(MIGRATIONS_DIR, filename) };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration versions must be sequential from 1; expected ${index + 1} but found ${migration.filename}`,
      );
    }
  });

  return migrations;
}

export async function migrate(database: Database = defaultDb): Promise<number> {
  const migrations = discoverMigrations();
  const currentVersion = (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  const pending = migrations.filter((migration) => migration.version > currentVersion);

  if (pending.length === 0) {
    log.debug('database schema is up to date', { version: currentVersion });
    return currentVersion;
  }

  for (const migration of pending) {
    const sql = await Bun.file(migration.path).text();
    // `user_version` takes a literal, so it cannot be a bound parameter — the
    // value is a validated integer parsed from the filename, never user input.
    database.transaction(() => {
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    log.info('applied migration', { version: migration.version, migration: migration.filename });
  }

  const newVersion = pending[pending.length - 1]!.version;
  log.info('database schema updated', { from: currentVersion, to: newVersion });
  return newVersion;
}

if (import.meta.main) {
  try {
    await migrate();
  } catch (error) {
    log.error('migration failed', { error });
    console.error('\nThe database could not be migrated. See the logged error above.');
    process.exit(1);
  }
}
