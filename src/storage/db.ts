/**
 * Opening the coordinator state store.
 *
 * - Mutating access acquires the coordinator lock first, then opens the
 *   database in WAL mode with foreign keys on and a busy timeout, and
 *   migrates it.
 * - Read-only access never touches the lock and never migrates; it only
 *   refuses schemas newer than this build supports.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { acquireCoordinatorLock, type CoordinatorLock } from './lock.js';
import { assertSchemaSupported, migrate, type MigrationResult } from './migrations.js';
import { ensureStateRoot, type StatePaths } from './paths.js';

export interface OpenDatabaseOptions {
  readonly readOnly?: boolean;
  readonly busyTimeoutMs?: number;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export class StateNotFoundError extends Error {
  constructor(databasePath: string) {
    super(`no coordinator state at ${databasePath}; run "workforce run" first or pass the correct --state-dir`);
    this.name = 'StateNotFoundError';
  }
}

/** Open a node:sqlite connection with the durability settings the coordinator relies on. */
export function openDatabase(databasePath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const readOnly = options.readOnly ?? false;
  if (readOnly && !existsSync(databasePath)) throw new StateNotFoundError(databasePath);
  const db = new DatabaseSync(databasePath, {
    readOnly,
    enableForeignKeyConstraints: true,
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    // FULL keeps committed receipts durable across power loss; the plan forbids weakening this for latency.
    db.exec('PRAGMA synchronous = FULL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export interface StateStore {
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly mode: 'mutating' | 'read-only';
  /** Present only for mutating stores. */
  readonly lock: CoordinatorLock | null;
  readonly migration: MigrationResult | null;
  close(): void;
}

export interface OpenStateStoreOptions {
  readonly mode: 'mutating' | 'read-only';
  readonly busyTimeoutMs?: number;
}

/**
 * Open the state store. Mutating mode creates the state root, takes the
 * coordinator lock and migrates; read-only mode does none of that.
 */
export function openStateStore(paths: StatePaths, options: OpenStateStoreOptions): StateStore {
  if (options.mode === 'read-only') {
    const db = openDatabase(paths.databasePath, { readOnly: true, ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}) });
    try {
      assertSchemaSupported(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return { paths, db, mode: 'read-only', lock: null, migration: null, close: () => db.close() };
  }

  ensureStateRoot(paths);
  const lock = acquireCoordinatorLock(paths.lockPath);
  let db: DatabaseSync;
  let migration: MigrationResult;
  try {
    db = openDatabase(paths.databasePath, options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {});
    try {
      migration = migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    lock.release();
    throw error;
  }
  let closed = false;
  return {
    paths,
    db,
    mode: 'mutating',
    lock,
    migration,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        lock.release();
      }
    },
  };
}
