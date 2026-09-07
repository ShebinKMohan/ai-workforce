/**
 * Versioned schema migrations. Newer-than-supported state is refused
 * without modification so a downgrade never erases user data (FR067 foundation).
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';
import { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from './schema.js';

export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `state schema version ${found} is newer than the supported version ${supported}; upgrade workforce or use a different --state-dir (the existing state was left untouched)`,
    );
    this.name = 'SchemaTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
}

/** Current schema version: 0 for a fresh database. Reads only; safe on read-only connections. */
export function getSchemaVersion(db: DatabaseSync): number {
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (table === undefined) return userVersion;
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  return Math.max(userVersion, row.version);
}

/** Throws when the database was written by a newer schema than this build supports. */
export function assertSchemaSupported(db: DatabaseSync): number {
  const version = getSchemaVersion(db);
  if (version > SUPPORTED_SCHEMA_VERSION) throw new SchemaTooNewError(version, SUPPORTED_SCHEMA_VERSION);
  return version;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: ReadonlyArray<number>;
}

/** Apply pending migrations, each in its own transaction. Refuses newer-than-supported schemas. */
export function migrate(db: DatabaseSync): MigrationResult {
  const from = assertSchemaSupported(db);
  ensureMigrationsTable(db);
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.description,
        nowIso(),
      );
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
  }
  return { from, to: getSchemaVersion(db), applied };
}
