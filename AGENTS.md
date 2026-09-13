# AGENTS.md — repository conventions for coding agents

Read `docs/plan.md` in full before changing anything. It is the authoritative specification.
Feature IDs (FR001–FR093), work packages (WP01–WP13, plus the WP10b day-one amendment) and acceptance tests (AT01–AT35) in that file are the scope references. Read section 17 for the current local workspace decisions and the features still deferred.

## What this repository is

AI Workforce is a local developer harness over installed coding runtimes (Codex, Claude Code),
with a desktop browser workspace and the compatible `workforce` CLI. Control Center provides AI
intake and department routing; heads plan and review work, while coordinator code owns capacity,
isolated candidate execution, independently captured checks and evidence-backed delivery.

## Stack (fixed for the MVP)

- Node.js (installed: v26.8.1) + TypeScript, ESM (`"type": "module"`), strict mode.
- SQLite via the built-in `node:sqlite` module (`DatabaseSync`). No native addons.
- Tests: vitest. Run with `npm test`. Type-check with `npm run typecheck`.
- Child processes: always `spawn(executable, argsArray, { shell: false })`. Never build shell strings from task text.
- Validation at boundaries with `zod`. Every persisted or exchanged record is versioned.

## Layout

```
src/cli/           commands, output rendering (human + --json), exit codes
src/core/          contracts, ids, state machine, policies, limits
src/discovery/     executable resolution, bounded probes, readiness/capability reports
src/adapters/      RuntimeAdapter contract, codex, claude-code, fake (test runtime)
src/coordination/  agent-callable bridge, messages, delivery (WP06+)
src/storage/       node:sqlite schema, migrations, transactions, operations, events, artifact store, lock
src/workspaces/    project inspection, candidate worktrees, snapshots, integration
src/verification/  contained check runner and acceptance
src/telemetry/     normalized events, timing, redaction
schemas/           JSON schema exports of the zod contracts
fixtures/          small fixture repositories and deterministic fake runtime scripts
tests/             unit, adapter, integration and acceptance tests
docs/              plan.md (spec), runtime compatibility notes, evidence records
```

## Hard rules

1. Never modify the user's checkout as an implicit setup step: no `git reset`, `git clean`, `git stash` on a registered project.
2. Coordinator state lives under a state root outside worker write access (default `~/.workforce`, override `--state-dir`). Tests use temp dirs.
3. A runtime saying "done" never marks a task accepted. Only verifier-executed checks against a frozen candidate do.
4. Passive discovery (`workforce doctor`) must never start a paid model turn.
5. Persist intent before spawning; persist receipts before releasing dependents. Use transactions.
6. Do not scan credential stores or extract tokens. Use documented login-status commands only.
7. Keep one small package. Do not create empty microservice packages or premature abstractions.
8. Tests must exercise behaviour (lifecycle, permissions, recovery), not mirror getters.
9. Record every runtime version tested and every capability as `unsupported | supported_unverified | verified`.
10. Commit with clear messages that name the work package and feature IDs, e.g. `WP03: Codex app-server adapter (FR003, FR058)`.

## Exit codes (frozen once CLI tests exist)

0 verified candidate · 2 invalid input/config · 3 required user action · 4 execution/validation failure · 130 interrupted.
