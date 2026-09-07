# Architecture — WP01 foundation, WP02–WP04 integrated

This document describes the module boundaries laid down by WP01 and the invariants each module enforces. `docs/plan.md` remains the specification; this file records how the code is organized to satisfy it. WP02 (discovery), WP03 (Codex adapter) and WP04 (workspaces, candidate runs and the contained check runner) are merged into `main` and build on these types without redesigning them; later packages (WP05 Claude Code, WP06 coordination) do the same.

## Package shape

One ESM TypeScript package (`workforce`), strict mode, Node 22+ with the built-in `node:sqlite`. Runtime dependency: `zod` only. Tests run with vitest against temporary state roots; nothing touches `~/.workforce` or a registered repository.

```
src/core        pure contracts, ids, lifecycle state machine, snapshots, config loading
src/storage     state root layout, SQLite schema/migrations, transactions, lock, operations, events, artifacts
src/adapters    RuntimeAdapter contract, the deterministic fake adapter and the Codex app-server adapter (claude-code arrives in WP05)
src/discovery   executable resolution, bounded passive probes, readiness and capability reports
src/workspaces  project inspection, candidate worktrees, snapshots
src/verification contained acceptance-check runner
src/telemetry   runtime-event normalization, events.jsonl projection, phase timing, redaction
src/cli         argument parsing (node:util parseArgs), human/--json output, exit codes, command stubs
fixtures        fake runtime script and example agent configuration
tests           behavioural tests: validation, lifecycle, operations, artifacts, lock, events, fake adapter, CLI
```

Dependency direction is one way: `cli → telemetry/adapters/storage → core`. `core` imports nothing from the other modules. `adapters/types.ts` depends only on `core`, so an adapter can be implemented without importing storage.

## core

- `process.ts` — process identity beyond a reusable pid: pid, start time observed via `ps` and a spawn token minted at spawn time. `matchProcessIdentity` answers `alive`, `dead`, `pid_reused` or `unverifiable`; the lock and the adapters both use it before acting on a recorded process.
- `contracts.ts` — zod schemas and inferred types for every document that crosses a boundary: the agent configuration file (`schemaVersion` 1), the effective agent binding, the task contract (v1), the run request and the lifecycle state enums. All object schemas are strict: unknown fields fail validation with the offending path. Cross references (agent → runtime, defaults → agent, duplicate agent ids, duplicate criterion ids) are checked in the same pass so a user sees every problem before anything executes.
- `state.ts` — the only place that knows which run/task/attempt transitions are legal. `running → accepted` does not exist; a worker result must pass `validating`. Nothing leaves `superseded`. `waiting` requires an explicit reason.
- `snapshot.ts` — resolves the effective binding (agent instructions + runtime/model/effort + policy + limits) and hashes its canonical JSON (sorted keys, no undefined members) with sha256. Attempts reference this hash; editing a configuration file cannot rewrite what an earlier attempt ran with.
- `ids.ts` — UUIDv7-style ids with a per-process monotonic counter, UTC timestamps, a monotonic clock and a sequence allocator. Durable ordering never relies on id ordering; it comes from the per-run `sequence` column.
- `config.ts` — reads and validates JSON documents from disk, reporting unreadable or malformed files with the file path.

## storage

- `paths.ts` — `<state-root>/state.sqlite`, `coordinator.lock`, `manifest.json`, `runs/<run-id>/{request.json,contract.json,config-snapshot.json,events.jsonl,artifacts/...}` and `<workspace-root>/<run-id>/<task-id>/<attempt-id>`. The root defaults to `~/.workforce`, overridable by `--state-dir` or `WORKFORCE_STATE_DIR`. Path segments are validated so an id can never escape the layout.
- `db.ts` — opens `DatabaseSync` in WAL mode with `synchronous = FULL`, foreign keys on and a busy timeout. A mutating open takes the coordinator lock first and migrates; a read-only open never touches the lock and never migrates.
- `schema.ts` / `migrations.ts` — schema v1 with the twelve record tables from plan section 8 plus `schema_migrations`. Each migration runs in its own `BEGIN IMMEDIATE` transaction. A database written by a newer schema is refused in both modes and left untouched.
- `tx.ts` — `withTransaction` joins an outer transaction when one is active; a failure anywhere rolls back the outermost transaction. `onCommit` hooks run only after the outermost commit, so notifications never fire for rolled-back work. The connection is marked "in a helper transaction" only after `BEGIN IMMEDIATE` succeeded: a BEGIN that fails (SQLITE_BUSY after the busy timeout, disk full) leaves no marker behind, so later calls open real transactions instead of silently running in autocommit.
- `lock.ts` — ownership is arbitrated by the kernel: `coordinator.lock.sqlite` is a tiny SQLite database and the holder keeps a `BEGIN IMMEDIATE` transaction open on it for its lifetime. A second coordinator (another process or another connection in this process) gets SQLITE_BUSY at once, and the lock vanishes the instant the holder dies, even from SIGKILL, so there is no stale lock to reclaim and no reclaim race between concurrent coordinators. The arbiter file is never deleted (unlinking a file another process has open would detach its lock). `coordinator.lock` is the human-readable companion the winner writes afterwards (pid, process start time via `ps`, hostname, token, acquisition time); it feeds "held by pid N" diagnostics and `readLockInfo`, never the ownership decision. Release removes the info file only while it still carries the releaser's token, then closes the arbiter.
- `records.ts` — row helpers for runs, tasks, attempts and agent snapshots. Every state change passes through `assertTransition`, so an illegal transition cannot reach the database. `beginNewGeneration` supersedes every open attempt of the older generation. An attempt records its worker as a full process identity (`process_id`, `process_started_at_ms`, `process_spawn_token`); `attemptProcessIdentity` rebuilds it for a restarted coordinator.
- `operations.ts` — durable intent → dispatched → receipt, all bound to the task's current generation: an intent carrying a superseded generation is refused, a dispatch of an intent whose generation was superseded in the meantime is refused and the intent closed (`failed`, reason `stale_generation`), and late receipts from superseded generations are rejected. Every rejection is recorded as an event. Duplicate receipts are idempotent; conflicting receipts are errors; `uncertain` is a first-class state that reconciliation resolves.
- `events.ts` — append with a per-run monotonic `sequence` allocated inside the same `BEGIN IMMEDIATE` transaction as the insert; optional idempotency keys make re-ingestion of the same runtime event a no-op. Replay delivers in order from a cursor. A payload above `MAX_EVENT_PAYLOAD_BYTES` (16 KiB) is refused: large payloads belong in the artifact store.
- `artifacts.ts` — write to a temp file in the run's artifacts directory, fsync, verify the on-disk hash, rename, fsync the directory, then insert the receipt in a transaction. A receipt never exists without its bytes; a crash before the insert leaves an orphan file for reconciliation. Reads re-hash and fail loudly on missing or corrupted content.

## adapters

`types.ts` is the contract from plan section 6: `probe`, `capabilities`, `validateSettings`, `openSession`, `resumeSession`, `startTurn`, `events`, `deliver`, `interrupt`, `stopOwnedProcesses`, `reconcile`. Concrete types cover readiness (installed / adapter-supported / controllable / authentication / ready, with `probeKind: 'passive' | 'live'`), capabilities (`unsupported | supported_unverified | verified`, each with the tested version and OS) together with the model/effort values the adapter offers and their provenance (`reported` by the runtime or `configured` by the adapter), session handles carrying a full `ProcessIdentity`, a `ResumeInput.previousProcess` the adapter must verify before spawning a successor, normalized `RuntimeEvent`s (kind, spawn token, per-process sequence, timestamp, payload, `rawRef`), receipts that distinguish `queued` from `submitted_to_active_turn`, `requested` from `observed`, and `requested` from `process_tree_terminated` from `unknown`, and an `ObservedRuntimeState` that says how the recorded identity compares with what runs now.

Settings (FR006): `validateSettings` reports each of model and effort as `runtime_default`, `supported`, `supported_unverified` (the runtime accepts values the adapter cannot list; they are passed through unchanged and the effective value is recorded from what the runtime reports) or `unsupported`. `validateBindingSettings(adapter, binding)` is the hook the CLI calls before recording intent; an adapter's `openSession` refuses a binding that is not ok instead of mapping it silently.

`fake/adapter.ts` drives `fixtures/fake-runtime/fake-runtime.mjs` (JSON lines on stdin/stdout). It is the reference implementation for the behaviours real adapters must reproduce: validate settings before spawning and refuse unsupported ones, spawn with `shell: false` and a minimal environment, own a process group (`detached: true`) so the whole tree can be terminated, mint a spawn token per process instance and stamp it on every event and raw reference, tolerate malformed and partial lines by emitting `raw` events instead of throwing, preserve unknown raw fields in the payload, mark `file_change` events with `withinAllowedPaths`, refuse a second concurrent turn, refuse to resume while the previously recorded process is still alive, and after a coordinator restart signal or report a process only when its recorded identity (pid + start time) still matches — a reused pid is never signalled and a bare pid is reported as `unknown`. Scenario files make it edit a file, claim "done" without editing, sleep, write outside the workspace, exit unexpectedly, hang until SIGTERM, or emit unknown/malformed output; `--model`/`--effort` are echoed in `session_started` so the effective values are recorded from what the runtime reports.

## telemetry

- `events.ts` — maps a `RuntimeEvent` onto an application event row with idempotency key `<adapter>:<session>:<spawnToken>:<sequence>` (a resumed session runs in a new process that numbers its events from 1 again; the spawn token keeps those from colliding with what the previous process already stored) and keeps `rawRef` in the payload. `recordRuntimeEvent` publishes a payload above the row limit to the artifact store as `events/<adapter>/<session>/<spawnToken>-<sequence>.json` inside the same transaction as the event insert; the row keeps a truncated summary and the artifact id in `payloadRef`, and a replay reuses the published bytes. `summarizeTurnEvidence` separates what the runtime claimed (`claimedDone`) from what was observed (file changes, containment violations, completion, interruption). `projectEventsJsonl` appends new events to `runs/<run-id>/events.jsonl` after redaction; the file is a regenerable projection, SQLite stays authoritative.
- `timing.ts` — `PhaseTimer` records dispatch, startup, runtime, validation and integration spans separately; usage that cannot be observed is reported as `unavailable`, never as zero.
- `redaction.ts` — masks values whose keys are credential-shaped, judged on the key's words (`_`, `-`, `.`, whitespace and camelCase boundaries): `password`, `secret`, `authorization`, `credential`, `cookie`, `passphrase`, `bearer`, `apikey` anywhere; `token` as the last word; `key` as the last word after a qualifier such as `api`, `access`, `private` or `secret`. `authentication`, `inputTokens`, `idempotencyKey`, `author`, `keyPath` and `hotkeys` stay readable. Free text is scrubbed for bearer tokens, `KEY=value` / `KEY: value` pairs with a sensitive key, credentials embedded in URLs and well-known credential prefixes. Every terminal line, JSON document and projection passes through it; the database keeps the raw value only where the coordinator needs it.

## cli

`workforce doctor | run | status | resume` with `--repo`, `--agents`, `--task`, `--task-file`, `--agent`, `--check`, `--codex-path`, `--claude-path`, `--state-dir`, `--workspace-root`, `--json`. Exit codes are frozen by `tests/cli.test.ts`: 0 verified candidate, 2 invalid input/configuration, 3 required user action, 4 execution/validation failure, 130 interrupted. `--json` writes exactly one document to stdout and every diagnostic to stderr — except `run --json`, which emits JSONL (one event object per line, the final result object last). Configuration is validated and the state root resolved before any command body runs; an invalid configuration exits 2 without creating state. `status` opens the store read-only and never acquires the coordinator lock.

`runCli` is asynchronous: `doctor` spawns bounded probes and `run` drives a runtime session, neither of which a synchronous spawn can bound or terminate as a process group. `main()` installs a SIGINT handler that aborts the active command on the first Ctrl+C and force-exits 130 on the second.

`--state-dir` resolves the coordinator state root (`$WORKFORCE_STATE_DIR`, else `~/.workforce`) for every command. `--workspace-root` moves candidate workspaces off the state root; the paths manifest records the root the state was created with, and a later `--workspace-root` that disagrees with it exits 2 rather than writing somewhere the manifest does not describe. `resume` still reports `not_implemented` with exit 4 until WP09.

## Invariants enforced by WP01 code (and tested)

1. Invalid configuration fails before execution with the field path and a fix hint; unknown fields, unknown runtime/agent references and duplicate ids are all rejected.
2. Lifecycle transitions are validated by one pure table; a runtime saying "done" cannot move a task to `accepted`.
3. The attempt's agent snapshot is a content hash of the effective binding; key order does not change it, any content change does.
4. Intent is persisted before dispatch; intent, dispatch and receipt are bound to the task's current generation; receipts are idempotent; every stale-generation rejection is recorded.
5. Event sequences are monotonic per run across connections; replay is ordered and idempotent by key, and a resumed session's new process never has its events dropped as duplicates.
6. Artifact receipts never precede their bytes; missing or corrupted bytes are detected on read and invalidate dependent acceptance; event rows stay bounded and large runtime payloads live in the artifact store.
7. One mutating coordinator per state root, arbitrated by a kernel file lock that dies with its holder; concurrent coordinators racing for a dead holder's lock produce exactly one winner; read-only inspection never takes the lock.
8. Newer-than-supported state is refused without modification in both open modes.
9. Adapter streams survive unknown event kinds, unknown fields and malformed lines; receipts say what was requested versus observed; owned process trees are terminated as a group; after a restart a process is signalled only when its recorded identity (pid + start time + spawn token) matches, never by pid alone.
10. Human-readable output and projections are redacted without masking readiness, usage or git metadata fields; passive probes start no model turn.
11. A failed `BEGIN` never converts later transactions into autocommit; model/effort settings are validated against what the adapter offers before anything is spawned.

## Deliberately not in WP01

The Claude Code adapter (WP05), the coordination bridge (WP06), routing and handoff (WP07), integration and repair (WP08), cancellation/resume and reconciliation (WP09) and JSON-schema exports under `schemas/` (added when an external consumer needs them).

## Adapter registry (WP02–WP04 integration)

`src/core/run-direct.ts` holds the run path's single adapter registry. `createAdapter(runtime, context)` maps a configured runtime's `adapter` field onto an implementation: `fake` for the deterministic test runtime, `codex` for `src/adapters/codex`, and a refusal naming WP05 for `claude-code`. The `context` carries the attempt's identifiers and the run's `artifacts/logs` directory, so an adapter that captures raw runtime stdio writes it into the run's own evidence directory; the directory is created by the adapter only when a session is actually opened, so a refused run leaves nothing behind.

Model and reasoning effort configured on a runtime reach `openSession`, which for Codex applies them as process-level `-c` overrides (`thread/start` has no `effort` parameter). Pin a model in the agent configuration rather than inheriting the user's `~/.codex/config.toml` default, which may be incompatible with the installed CLI.

Usage (FR060) is read back from the adapter after the turn: an adapter that reports token counts yields `status: "measured"` with those counts, and `costUsd` stays `null` with a source line saying cost is unavailable — no installed runtime reports a price, and zero is never substituted for one.
