# Architecture — WP01 foundation

This document describes the module boundaries laid down by WP01 and the invariants each module enforces. `docs/plan.md` remains the specification; this file records how the code is organized to satisfy it. Later packages (WP02 discovery, WP03/WP05 real adapters, WP04 workspaces and checks, WP06 coordination) build on these types without redesigning them.

## Package shape

One ESM TypeScript package (`workforce`), strict mode, Node 22+ with the built-in `node:sqlite`. Runtime dependency: `zod` only. Tests run with vitest against temporary state roots; nothing touches `~/.workforce` or a registered repository.

```
src/core        pure contracts, ids, lifecycle state machine, snapshots, config loading
src/storage     state root layout, SQLite schema/migrations, transactions, lock, operations, events, artifacts
src/adapters    RuntimeAdapter contract + the deterministic fake adapter (real adapters arrive in WP03/WP05)
src/telemetry   runtime-event normalization, events.jsonl projection, phase timing, redaction
src/cli         argument parsing (node:util parseArgs), human/--json output, exit codes, command stubs
fixtures        fake runtime script and example agent configuration
tests           behavioural tests: validation, lifecycle, operations, artifacts, lock, events, fake adapter, CLI
```

Dependency direction is one way: `cli → telemetry/adapters/storage → core`. `core` imports nothing from the other modules. `adapters/types.ts` depends only on `core`, so an adapter can be implemented without importing storage.

## core

- `contracts.ts` — zod schemas and inferred types for every document that crosses a boundary: the agent configuration file (`schemaVersion` 1), the effective agent binding, the task contract (v1), the run request and the lifecycle state enums. All object schemas are strict: unknown fields fail validation with the offending path. Cross references (agent → runtime, defaults → agent, duplicate agent ids, duplicate criterion ids) are checked in the same pass so a user sees every problem before anything executes.
- `state.ts` — the only place that knows which run/task/attempt transitions are legal. `running → accepted` does not exist; a worker result must pass `validating`. Nothing leaves `superseded`. `waiting` requires an explicit reason.
- `snapshot.ts` — resolves the effective binding (agent instructions + runtime/model/effort + policy + limits) and hashes its canonical JSON (sorted keys, no undefined members) with sha256. Attempts reference this hash; editing a configuration file cannot rewrite what an earlier attempt ran with.
- `ids.ts` — UUIDv7-style ids with a per-process monotonic counter, UTC timestamps, a monotonic clock and a sequence allocator. Durable ordering never relies on id ordering; it comes from the per-run `sequence` column.
- `config.ts` — reads and validates JSON documents from disk, reporting unreadable or malformed files with the file path.

## storage

- `paths.ts` — `<state-root>/state.sqlite`, `coordinator.lock`, `manifest.json`, `runs/<run-id>/{request.json,contract.json,config-snapshot.json,events.jsonl,artifacts/...}` and `<workspace-root>/<run-id>/<task-id>/<attempt-id>`. The root defaults to `~/.workforce`, overridable by `--state-dir` or `WORKFORCE_STATE_DIR`. Path segments are validated so an id can never escape the layout.
- `db.ts` — opens `DatabaseSync` in WAL mode with `synchronous = FULL`, foreign keys on and a busy timeout. A mutating open takes the coordinator lock first and migrates; a read-only open never touches the lock and never migrates.
- `schema.ts` / `migrations.ts` — schema v1 with the twelve record tables from plan section 8 plus `schema_migrations`. Each migration runs in its own `BEGIN IMMEDIATE` transaction. A database written by a newer schema is refused in both modes and left untouched.
- `tx.ts` — `withTransaction` joins an outer transaction when one is active; a failure anywhere rolls back the outermost transaction. `onCommit` hooks run only after the outermost commit, so notifications never fire for rolled-back work.
- `lock.ts` — `coordinator.lock` holds pid, process start time (via `ps`), hostname, a random token and the acquisition time, written with `O_EXCL`. Liveness is judged by identity (pid and start time on the same host), never by heartbeat age; a live holder can never be displaced. A dead or pid-reused holder is reclaimed only if the file still carries the token that was inspected. Release removes the file only when it still carries the releaser's token.
- `records.ts` — row helpers for runs, tasks, attempts and agent snapshots. Every state change passes through `assertTransition`, so an illegal transition cannot reach the database. `beginNewGeneration` supersedes every open attempt of the older generation.
- `operations.ts` — durable intent → dispatched → receipt. Intent is committed before the effect starts; receipts for a superseded generation are rejected and the rejection is recorded as an event; duplicate receipts are idempotent; conflicting receipts are errors; `uncertain` is a first-class state that reconciliation resolves.
- `events.ts` — append with a per-run monotonic `sequence` allocated inside the same `BEGIN IMMEDIATE` transaction as the insert; optional idempotency keys make re-ingestion of the same runtime event a no-op. Replay delivers in order from a cursor.
- `artifacts.ts` — write to a temp file in the run's artifacts directory, fsync, verify the on-disk hash, rename, fsync the directory, then insert the receipt in a transaction. A receipt never exists without its bytes; a crash before the insert leaves an orphan file for reconciliation. Reads re-hash and fail loudly on missing or corrupted content.

## adapters

`types.ts` is the contract from plan section 6: `probe`, `capabilities`, `openSession`, `resumeSession`, `startTurn`, `events`, `deliver`, `interrupt`, `stopOwnedProcesses`, `reconcile`. Concrete types cover readiness (installed / adapter-supported / controllable / authentication / ready, with `probeKind: 'passive' | 'live'`), capabilities (`unsupported | supported_unverified | verified`, each with the tested version and OS), session and turn handles, normalized `RuntimeEvent`s (kind, per-session sequence, timestamp, payload, `rawRef`), and receipts that distinguish `queued` from `submitted_to_active_turn`, `requested` from `observed`, and `requested` from `process_tree_terminated` from `unknown`.

`fake/adapter.ts` drives `fixtures/fake-runtime/fake-runtime.mjs` (JSON lines on stdin/stdout). It is the reference implementation for the behaviours real adapters must reproduce: spawn with `shell: false` and a minimal environment, own a process group (`detached: true`) so the whole tree can be terminated, tolerate malformed and partial lines by emitting `raw` events instead of throwing, preserve unknown raw fields in the payload, mark `file_change` events with `withinAllowedPaths`, refuse a second concurrent turn, and reconcile from process identity after the coordinator forgot the session. Scenario files make it edit a file, claim "done" without editing, sleep, write outside the workspace, exit unexpectedly, hang until SIGTERM, or emit unknown/malformed output.

## telemetry

- `events.ts` — maps a `RuntimeEvent` onto an application event row with idempotency key `<adapter>:<session>:<sequence>` and `payloadRef = rawRef`; `summarizeTurnEvidence` separates what the runtime claimed (`claimedDone`) from what was observed (file changes, containment violations, completion, interruption). `projectEventsJsonl` appends new events to `runs/<run-id>/events.jsonl` after redaction; the file is a regenerable projection, SQLite stays authoritative.
- `timing.ts` — `PhaseTimer` records dispatch, startup, runtime, validation and integration spans separately; usage that cannot be observed is reported as `unavailable`, never as zero.
- `redaction.ts` — masks values whose keys match `/TOKEN|SECRET|KEY|PASSWORD|AUTH/i`, bearer-like strings, `KEY=value` pairs and well-known credential prefixes. Every terminal line, JSON document and projection passes through it; the database keeps the raw value only where the coordinator needs it.

## cli

`workforce doctor | run | status | resume` with `--repo`, `--agents`, `--task`, `--task-file`, `--state-dir`, `--json`. Exit codes are frozen by `tests/cli.test.ts`: 0 verified candidate, 2 invalid input/configuration, 3 required user action, 4 execution/validation failure, 130 interrupted. `--json` writes exactly one document to stdout and every diagnostic to stderr. Configuration is validated and the state root resolved before any command body runs; an invalid configuration exits 2 without creating state. `status` opens the store read-only and never acquires the coordinator lock. `doctor`, `run` and `resume` report `not_implemented` with exit 4 until WP02, WP03/WP04 and WP09 respectively.

## Invariants enforced by WP01 code (and tested)

1. Invalid configuration fails before execution with the field path and a fix hint; unknown fields, unknown runtime/agent references and duplicate ids are all rejected.
2. Lifecycle transitions are validated by one pure table; a runtime saying "done" cannot move a task to `accepted`.
3. The attempt's agent snapshot is a content hash of the effective binding; key order does not change it, any content change does.
4. Intent is persisted before dispatch; receipts are idempotent; late receipts from superseded generations are rejected and recorded.
5. Event sequences are monotonic per run across connections; replay is ordered and idempotent by key.
6. Artifact receipts never precede their bytes; missing or corrupted bytes are detected on read and invalidate dependent acceptance.
7. One mutating coordinator per state root, judged by process identity rather than a timeout; read-only inspection never takes the lock.
8. Newer-than-supported state is refused without modification in both open modes.
9. Adapter streams survive unknown event kinds, unknown fields and malformed lines; receipts say what was requested versus observed; owned process trees are terminated as a group and reconciled from process identity.
10. Human-readable output and projections are redacted; passive probes start no model turn.

## Deliberately not in WP01

Executable discovery and readiness reports (WP02), Codex and Claude Code adapters (WP03, WP05), repository inspection, candidate worktrees and the contained check runner (WP04), the coordination bridge (WP06) and JSON-schema exports under `schemas/` (added when an external consumer needs them).
