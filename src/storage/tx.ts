/**
 * Transaction helper for node:sqlite.
 *
 * - Nested calls join the outer transaction (no SAVEPOINT games; a failure
 *   anywhere rolls back the outermost transaction).
 * - `onCommit` callbacks run after the outermost COMMIT succeeds, so
 *   notifications never fire for work that was rolled back.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface TransactionContext {
  readonly db: DatabaseSync;
  /** Register work to run after the outermost transaction commits. */
  onCommit(callback: () => void): void;
  readonly depth: number;
}

interface ActiveTransaction {
  depth: number;
  hooks: Array<() => void>;
}

const active = new WeakMap<DatabaseSync, ActiveTransaction>();

export function inTransaction(db: DatabaseSync): boolean {
  return active.has(db) || db.isTransaction;
}

export function withTransaction<T>(db: DatabaseSync, fn: (tx: TransactionContext) => T): T {
  const existing = active.get(db);
  if (existing !== undefined) {
    existing.depth += 1;
    try {
      return fn({ db, depth: existing.depth, onCommit: (cb) => existing.hooks.push(cb) });
    } finally {
      existing.depth -= 1;
    }
  }
  if (db.isTransaction) {
    // A transaction opened outside this helper (for example by migrations): join it, hooks run immediately after fn.
    const hooks: Array<() => void> = [];
    const result = fn({ db, depth: 1, onCommit: (cb) => hooks.push(cb) });
    for (const hook of hooks) hook();
    return result;
  }

  const state: ActiveTransaction = { depth: 1, hooks: [] };
  active.set(db, state);
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn({ db, depth: 1, onCommit: (cb) => state.hooks.push(cb) });
    db.exec('COMMIT');
  } catch (error) {
    active.delete(db);
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone (for example after a constraint failure aborted it).
    }
    throw error;
  }
  active.delete(db);
  for (const hook of state.hooks) hook();
  return result;
}
