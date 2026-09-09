/**
 * Run output with an identity.
 *
 * A run emits two kinds of output: normalized event records (JSONL with
 * `--json`) and human progress lines. Until now both arrived at the renderer
 * anonymous, and every concurrently dispatched task of a planned run was
 * handed the SAME `RunStream`. Interleaved output from N workers was therefore
 * one flat stream in which nothing said which worker produced which line, and
 * the only way to guess was to read the prose.
 *
 * The fix is a derived stream. `forTask(parent, identity)` returns a stream
 * that stamps every record and every line with `{ runId, taskId, attemptId,
 * agentId, runtimeId, adapter, key }` — whichever of those are known — and
 * delegates to its parent. Both paths use it: the planned path derives one per
 * dispatched task, and the direct path derives one for its single task, so a
 * renderer sees the same shape either way and never has to special-case a
 * single-task run.
 *
 * Two rules keep this honest:
 *
 * - Identity travels in the record, not in the prose. A renderer decides
 *   whether to SHOW it (the plain renderer shows it only once more than one
 *   task has been live at the same time), so a single-task run's human output
 *   is exactly what it always was.
 * - Nothing is removed. The identity fields are added under the record's own
 *   fields, so a record that already names its `adapter` or `taskId` keeps the
 *   value it set.
 */

/** Everything a renderer may need to route a line or a record. All optional: a run-level stream knows none of it. */
export interface RunStreamIdentity {
  readonly runId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  /** The configured agent id, e.g. "engineer-codex". */
  readonly agentId?: string;
  /** The configured runtime id this agent is bound to. */
  readonly runtimeId?: string;
  /** The adapter that drives the runtime, e.g. "codex" or "claude-code". */
  readonly adapter?: string;
  /** The plan key of this task, for a planned run. Absent on the direct path. */
  readonly key?: string;
}

/**
 * Who composed a human line, which is not the same question as who it is about.
 *
 * A line's identity says which task produced it. Its origin says whether the
 * words are this program's or somebody else's, and that is what a renderer
 * needs before it is allowed to put a mark on the line:
 *
 * - `verifier` — composed by the coordinator from a check receipt it executed
 *   itself against a frozen candidate. The only origin a green tick may come
 *   from, because it is the only one that is evidence (AGENTS.md rule 3).
 * - `coordinator` — composed by the coordinator from its own state. Trustworthy
 *   about the run, but not evidence about the work, so never green.
 * - `runtime` — carries text a runtime or a repository produced: a model's
 *   sentence, a shell command, a diff hunk. Never classified and never
 *   coloured, because a model that writes "the suite: passed" would otherwise
 *   get the same green tick as a verifier that ran it.
 *
 * Absent means `coordinator`: every line predates this field and every one of
 * them is composed here.
 */
export type LineOrigin = 'coordinator' | 'verifier' | 'runtime';

const IDENTITY_FIELDS = ['runId', 'taskId', 'attemptId', 'agentId', 'runtimeId', 'adapter', 'key'] as const;

export interface RunStream {
  /** One normalized record; rendered as a line for humans or a JSONL object with --json. */
  event(record: Record<string, unknown> & { readonly type: string }): void;
  /** Human progress line. */
  line(text: string): void;
  /**
   * What this stream stamps on everything it emits. Undefined on a run-level
   * stream; set on one returned by `forTask`.
   */
  readonly identity?: RunStreamIdentity;
  /**
   * Identity-aware line sink. A renderer implements it so a line arrives with
   * the identity of whoever wrote it; a plain `{ event, line }` stream (every
   * existing test double) does not, and derived streams then fall back to
   * `line`, which is exactly the old behaviour.
   */
  writeLine?(text: string, identity: RunStreamIdentity, origin?: LineOrigin): void;
  /** A task's stream opened. A renderer counts these to know how many tasks are live. */
  openTask?(identity: RunStreamIdentity): void;
  /** That task's stream closed. Never called for a task that was never opened. */
  closeTask?(identity: RunStreamIdentity): void;
}

/** A stream bound to one task. `close()` tells the renderer that task is no longer live. */
export interface TaskStream extends RunStream {
  readonly identity: RunStreamIdentity;
  close(): void;
}

export const SILENT_STREAM: RunStream = { event: () => {}, line: () => {} };

/**
 * Merge two identities, later wins, undefined never overwrites.
 *
 * Built key by key rather than by spreading, because `exactOptionalPropertyTypes`
 * distinguishes an absent field from one explicitly set to `undefined`, and a
 * record carrying `"taskId": undefined` is not the same contract as one that
 * carries no `taskId` at all.
 */
export function mergeIdentity(base: RunStreamIdentity | undefined, extra: RunStreamIdentity | undefined): RunStreamIdentity {
  const merged: Record<string, string> = {};
  for (const source of [base, extra]) {
    if (source === undefined) continue;
    for (const field of IDENTITY_FIELDS) {
      const value = source[field];
      if (value !== undefined) merged[field] = value;
    }
  }
  return merged as RunStreamIdentity;
}

/** The identity as a plain record, ready to be spread under an event's own fields. */
export function identityFields(identity: RunStreamIdentity): Record<string, string> {
  return mergeIdentity(identity, undefined) as Record<string, string>;
}

/** True when this identity names a task at all. */
export function hasTaskIdentity(identity: RunStreamIdentity | undefined): boolean {
  return identity?.taskId !== undefined;
}

/**
 * A stream that stamps everything it emits with `identity` and delegates to
 * `parent`.
 *
 * Derivation composes: `forTask(forTask(s, a), b)` carries `a` merged with
 * `b`. That is how the direct path narrows its own stream twice — once when
 * the ids are minted and again when the adapter is known — without opening the
 * same task twice: a derivation that does not introduce a NEW task id (because
 * the parent already names it) registers nothing and its `close()` is a no-op,
 * so the task's liveness belongs to whoever actually opened it.
 */
export function forTask(parent: RunStream, identity: RunStreamIdentity): TaskStream {
  const merged = mergeIdentity(parent.identity, identity);
  const introducesTask = merged.taskId !== undefined && parent.identity?.taskId !== merged.taskId;
  const stamp = identityFields(merged);

  const write = (text: string, extra: RunStreamIdentity, origin: LineOrigin | undefined): void => {
    if (parent.writeLine !== undefined) parent.writeLine(text, mergeIdentity(merged, extra), origin);
    else parent.line(text);
  };

  let closed = false;
  const stream: TaskStream = {
    identity: merged,
    event: (record) => {
      parent.event({ ...stamp, ...record });
    },
    line: (text) => {
      write(text, {}, undefined);
    },
    writeLine: (text, extra, origin) => {
      write(text, extra, origin);
    },
    openTask: (extra) => {
      parent.openTask?.(mergeIdentity(merged, extra));
    },
    closeTask: (extra) => {
      parent.closeTask?.(mergeIdentity(merged, extra));
    },
    close: () => {
      if (closed || !introducesTask) return;
      closed = true;
      parent.closeTask?.(merged);
    },
  };

  if (introducesTask) parent.openTask?.(merged);
  return stream;
}

/**
 * A human line whose origin is not the default.
 *
 * `RunStream.line` has no room for one and every existing test double
 * implements only `{ event, line }`, so this asks for `writeLine` and falls
 * back to `line` when the sink is one of those. A renderer that cannot be told
 * the origin renders the line uncoloured, which is the safe direction.
 */
export function writeLineFrom(stream: RunStream, text: string, origin: LineOrigin): void {
  if (stream.writeLine !== undefined) stream.writeLine(text, {}, origin);
  else stream.line(text);
}
