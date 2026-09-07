import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { listOpenOperations, recordIntent } from '../src/storage/operations.js';
import { inTransaction, withTransaction } from '../src/storage/tx.js';
import { openTempState, seedRunAndTask, type TempState } from './helpers/state.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

describe('withTransaction after a failed BEGIN', () => {
  it('reports the lock error and keeps running real transactions afterwards (no autocommit leak)', () => {
    const { run, task } = seedRunAndTask(state);
    const db = state.store.db;
    // A second connection takes the write lock; the coordinator connection must not wait long for the test.
    const blocker = openDatabase(state.paths.databasePath, { busyTimeoutMs: 100 });
    const victim = openDatabase(state.paths.databasePath, { busyTimeoutMs: 100 });
    try {
      blocker.exec('BEGIN IMMEDIATE');
      expect(() => withTransaction(victim, () => 1)).toThrow(/database is locked/);
      // The failed BEGIN must not leave the helper believing a transaction is open.
      expect(inTransaction(victim)).toBe(false);
      expect(victim.isTransaction).toBe(false);
      blocker.exec('ROLLBACK');

      // Now the same connection must run a real transaction: writes inside a failing callback are rolled back...
      const hooks: string[] = [];
      let sawTransaction = false;
      expect(() =>
        withTransaction(victim, (tx) => {
          sawTransaction = victim.isTransaction;
          recordIntent(victim, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: {} });
          tx.onCommit(() => hooks.push('never'));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(sawTransaction).toBe(true);
      expect(listOpenOperations(db, run.id)).toEqual([]);
      expect(hooks).toEqual([]);

      // ...and commit hooks fire only after a successful COMMIT.
      const op = withTransaction(victim, (tx) => {
        tx.onCommit(() => hooks.push('after-commit'));
        return recordIntent(victim, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: {} });
      });
      expect(hooks).toEqual(['after-commit']);
      expect(listOpenOperations(db, run.id).map((o) => o.id)).toEqual([op.id]);
      expect(inTransaction(victim)).toBe(false);
    } finally {
      victim.close();
      blocker.close();
    }
  });

  it('does not treat a transaction ended behind its back as still open', () => {
    const db = state.store.db;
    const { run, task } = seedRunAndTask(state);
    let nestedSawTransaction = false;
    expect(() =>
      withTransaction(db, () => {
        db.exec('COMMIT'); // a misbehaving callback ends the helper's transaction directly
        // The nested call must not run in autocommit under the stale marker: it starts (and commits) a real transaction.
        withTransaction(db, () => {
          nestedSawTransaction = db.isTransaction;
          recordIntent(db, { runId: run.id, taskId: task.id, kind: 'a', intent: {} });
        });
        expect(db.isTransaction).toBe(false);
      }),
    ).toThrow(/no transaction is active/); // the outer helper reports the broken contract instead of hiding it
    expect(nestedSawTransaction).toBe(true);
    expect(listOpenOperations(db, run.id)).toHaveLength(1);
    expect(inTransaction(db)).toBe(false);
    // The connection is healthy afterwards.
    withTransaction(db, () => recordIntent(db, { runId: run.id, taskId: task.id, kind: 'b', intent: {} }));
    expect(listOpenOperations(db, run.id)).toHaveLength(2);
  });
});
