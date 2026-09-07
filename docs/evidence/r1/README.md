# R1 gate record — AT04, AT05, AT06, AT07, AT09 against real runtimes

Release gate: **R1** · Work package: **WP10 (gate)** · Recorded 7 September 2026 on the author's
macOS machine, against `main` at the commit this directory is added to (parent `d4ebd13`,
"Integrate WP06-WP09"), with `dist/` built by `npm run build` from that tree.

**Verdict: R1 does not pass.** Of the five acceptance tests in scope, one passes in part, one
fails on an unhandled database error, and three cannot be reached from the shipped product at
all. Everything below is what was executed. Where a test was not run, it says so and says why;
a test that was not run is not recorded as a pass.

| Test | Verdict | One line |
| --- | --- | --- |
| AT04 cross-runtime handoff | **NOT RUN — unreachable** | no code path in any run builds, applies or transports a handoff packet |
| AT05 peer clarification | **FAIL** | the run was accepted, and zero coordination messages were exchanged |
| AT06 bounded repair | **FAIL** | the first repair attempt dies with `UNIQUE constraint failed: attempts.task_id, attempts.generation` |
| AT07 cancel and resume | **PARTIAL** | cancellation passes; `resume` reconciles but never continues the work |
| AT09 dependency release | **NOT RUN — unreachable** | dependencies cannot be expressed, and a planned run executes tasks serially |

## Environment

| Fact | Value |
| --- | --- |
| Runtimes | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex` (model `gpt-5.6-sol`, effort `low`), `claude 2.1.260` at `~/.local/bin/claude` |
| Node | v26.8.1 · darwin 25.6.0 arm64 |
| `npm run typecheck` | exit 0 |
| Agent config used | [`agents.json`](agents.json) — worker and planner both `engineer-codex` |

`claude-code` was configured but no R1 test in this record reached it: every test that would have
needed a second runtime (AT04) is unreachable, and the reachable tests are cheaper on one runtime.

## Fixture

A throwaway Git repository with one script, [`fixture-check.mjs`](fixture-check.mjs), providing
three deterministic acceptance checks:

- `node scripts/check.mjs lint` — every `docs/*.md` begins with a markdown title. Passes at base.
- `node scripts/check.mjs strict` — additionally requires the line `Status: reviewed`.
- `node scripts/check.mjs sealed` — requires a release token that is **not present anywhere in the
  repository**, so no worker can satisfy it. This is the deliberately failing check AT06 asks for;
  it fails honestly rather than by being unfixable-looking, and it is the only way to reach the
  repair loop, because a worker that can run the check itself simply satisfies it on the first
  attempt (observed: the `strict` variant was discovered and satisfied first try, no repair).

## Baseline — the direct path still works

Before the gate tests, one direct run on the same fixture with the `strict` check:

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json --path direct \
    --task-file <two deliverables> --check "node scripts/check.mjs strict" \
    --state-dir <state> --workspace-root <ws>
route: direct — the planned route was requested but no planner agent is configured
...
EXIT=0
```

Two things this recorded, both of which matter to the tests below:

1. **`--path planned` is silently downgraded to `direct` when `defaults.plannerAgent` is unset.**
   The route line says so, but the exit code is 0 and the run proceeds. Every planned-path test
   below therefore had to add `plannerAgent` to the agent config first.
2. The worker read `scripts/check.mjs`, discovered the `strict` requirement and satisfied it on
   the first attempt. This is good behaviour, and it is why AT06 needs a check the repository
   cannot answer.

## AT04 — cross-runtime handoff · NOT RUN (unreachable)

> *A task started on one runtime is handed to the other via the portable packet, and the second
> runtime result demonstrably uses the handed-over contract, findings and candidate.*

**Not run.** There is nothing to run it against. `src/routing/handoff.ts` builds and applies
packets and is unit-tested, but no orchestrator, CLI command or adapter ever calls it, and no code
selects a different runtime for a second attempt. From
[`logs/static-probes.txt`](logs/static-probes.txt):

```
$ grep -rn "buildHandoffPacket|applyHandoffPacket|parseHandoffPacket" src --include=*.ts
src/recovery/fallback.ts:164:export function buildHandoffPacket(...)
src/routing/handoff.ts:170:export function parseHandoffPacket(...)
src/routing/handoff.ts:177:export function buildHandoffPacket(...)
src/routing/handoff.ts:219:export function applyHandoffPacket(...)

$ grep -rn "fallback" src/core src/cli --include=*.ts
(no matches)
```

Every hit is a definition or a re-export; there is no call site. `src/recovery/fallback.ts`, which
would choose the second runtime, is imported by nothing outside its own barrel. A run cannot hand
a task from Codex to Claude Code today, so the packet's runtime-neutrality has never been exercised
end to end.

## AT05 — real peer clarification through the bridge · FAIL

> *Two isolated workers exchange a REAL peer clarification through the bridge (not a manager
> relay) and the combined candidate passes its checks.*

Request ([`at05-request.txt`](at05-request.txt)) gives task 1 a free choice and makes task 2
depend on knowing it, and tells both workers to use their coordination tools and not to guess.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json --path planned \
    --task-file at05-request.txt --check "node scripts/check.mjs lint" \
    --state-dir <state> --workspace-root <ws>
route: planned — the operator asked for the planned route
run 01a07d16-6ffc-7591-8880-b552c7fe1d28 (planned, 2 tasks)
coordination: /var/folders/.../wf-01a07d16-4ed50e31.sock
...
run 01a07d16-6ffc-7591-8880-b552c7fe1d28: accepted (planned, 2 tasks)
  PASS t1: Create the file docs/glossary.md whose first line is "# Glossary". Choose exactly one
  PASS t2: Create the file docs/usage.md whose first line is "# Usage". It must use, verbatim, the
combined candidate d093530ea40a: accepted — every required criterion was executed against the
  combined revision d093530ea40a6ae704816ac346157f8c239d4c6a and passed
```

The combined candidate passed its checks. **No clarification happened.** Reading the run's own
state database:

```
$ node dump-messages.mjs <state>/state.sqlite
# 0 message row(s)
```

Zero coordination messages of any kind — not a peer message, not a coordinator message. The two
produced files contain their title line and nothing else:

```
$ cat <ws>/.../docs/glossary.md
# Glossary
$ cat <ws>/.../docs/usage.md
# Usage
```

Three causes, all visible in the run:

1. **A worker is never told any peer's task id.** `composeTaskPrompt` (src/core/run-direct.ts)
   emits workspace, base revision, dependency briefing, inbox and criteria — never the task's own
   id nor a peer's. The bridge itself refuses an unknown recipient with
   *"address a peer task id from your context"*, and no such id is ever put in that context.
2. **The two workers are never alive at the same time.** `runPlanned` executes a dispatched batch
   one task at a time by design (src/core/run-planned.ts:275-279), so a question from the second
   worker can never be answered by the first, which has already finished.
3. **Each planned worker sees only its own truncated objective line, not the request.**
   `taskText = slot?.objective ?? input.requestText` (src/core/run-direct.ts:946), and
   `decomposeRequest` takes only the first line of each enumerated item. The instruction to define
   a term and to ask a peer was on the item's continuation lines and never reached either worker.
   The second worker said so itself in the transcript: *"the truncated request refers to"*.

The run was still marked accepted, because the one configured check passes on a title-only file.
That is an honest acceptance of a dishonest decomposition: the checks were executed and did pass,
but nothing the request actually asked for was produced.

Files: [`logs/at05-run.txt`](logs/at05-run.txt),
[`manifests/at05-planned-result.json`](manifests/at05-planned-result.json).

## AT06 — bounded repair · FAIL

> *A deliberately failing check drives bounded repair, then either passes or accurately reports
> the exhausted budget.*

Same two-deliverable plan, with the unsatisfiable `sealed` check added and
`defaults.maxRepairAttempts: 1`.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json --path planned \
    --task-file at06-request.txt \
    --check "node scripts/check.mjs lint" --check "node scripts/check.mjs sealed" \
    --state-dir <state> --workspace-root <ws>
task "t1": Create the file docs/alpha.md whose first line is "# Alpha".
...
running 2 acceptance check(s) against the frozen candidate
  check check-1: passed (exit 0) in 47ms
  check check-2: failed (exit 1) in 48ms
not accepted: criterion "check-2" failed with exit 1
task "t1" (repair 1): Create the file docs/alpha.md whose first line is "# Alpha".
acceptance: 2 check(s) from --check flags
acceptance fixtures (the worker must not rewrite these; new test files are fine): .workforce/checks.json, scripts/check.mjs
error: UNIQUE constraint failed: attempts.task_id, attempts.generation
EXIT=4
```

The failure is deterministic: it was reproduced on a second, independent run with a fresh state
root ([`logs/at06-run-reproduced.txt`](logs/at06-run-reproduced.txt)), same error, exit code 4.

The failing check is detected correctly, the repair decision is taken correctly and the repair
attempt is announced — and then the run dies with a raw SQLite constraint error before the repair
worker starts. No `planned-result.json` is written, because the run never reaches `finish()`.

Root cause: `runTaskWithRepair` (src/core/run-planned.ts) calls `runDirect` again with the **same
`taskId`** and a new `attemptId`, but nothing bumps the task's generation. `insertAttempt`
(src/storage/records.ts:237) writes the new attempt at `task.current_generation`, which is still
the failed attempt's generation, and the unique index on `(task_id, generation)` rejects it. The
function that would fix this, `startGeneration` (src/storage/records.ts:188-197), exists and is
what `resume` uses — the repair path just never calls it.

The consequence is larger than AT06: **any planned run in which any task's checks fail dies with
an unhandled database error**, whenever `maxRepairAttempts > 0`.

Files: [`logs/at06-run.txt`](logs/at06-run.txt).

## AT07 — cancel during editing, then resume · PARTIAL

> *Cancellation during editing stops or isolates the writer; explicit resume preserves completed
> work and creates no duplicate accepted writer.*

A direct run was given eight files to write and was sent `SIGINT` only once five of them existed
in the candidate worktree, so the interrupt genuinely landed mid-edit
([`logs/at07-interrupt-timeline.txt`](logs/at07-interrupt-timeline.txt)).

### Cancellation half — passes

```
observed 5 docs/*.md in the candidate at 2026-09-07T18:18:33Z
sending SIGINT at 2026-09-07T18:18:33Z
EXIT=130
```

```
interrupted: work preserved on the candidate branch, nothing accepted
run 01a07d16-c328-76d3-ada4-97071a5a7c19: interrupted
task 01a07d16-c328-76d4-b7ed-67224bf2ecb3: cancelled
  NONE check-1: no verifier-executed check produced evidence for this criterion
unresolved:
  - the run was interrupted before acceptance; resume creates a new attempt generation for this task
```

The partial work is a real checkpoint commit on the candidate branch, and nothing was accepted:

```
$ git -C <candidate worktree> show --stat HEAD
commit c5dce7d40d8a80307aedf607d4d5e2e299311f10
    workforce candidate checkpoint
    run: 01a07d16-c328-76d3-ada4-97071a5a7c19
 docs/n01.md | 3 +++   docs/n02.md | 3 +++   docs/n03.md | 3 +++
 docs/n04.md | 3 +++   docs/n05.md | 3 +++
 5 files changed, 15 insertions(+)
```

The interruption is persisted before the process is stopped — `run.interrupt_requested`,
`runtime.turn_interrupted`, `run.interrupt_acknowledged`, `runtime.stopped`, `candidate.snapshot`,
`run.interrupted`, in that order in the event log.

### Resume half — fails

```
$ node dist/cli/index.js resume 01a07d16-c328-76d3-ada4-97071a5a7c19 --agents agents.json --state-dir <state>
run 01a07d16-c328-76d3-ada4-97071a5a7c19: running (ownership epoch 1)
reconciled 1 attempt, 0 open operations
  replace 01a07d16-c328-76d5-... (task 01a07d16-...-b7ed-..., gen 1 -> 2 as 01a07d18-5d43-...)
    — the recorded worker process 75515 is gone; session ... cannot be rejoined,
      so a new generation may take over
state reconciled under this coordinator; execution continuation is not wired in this build
EXIT=0
```

`resume` reconciles honestly and says plainly that it does not continue the work. The CLI wires no
continuation at all (src/cli/index.ts, `commandResume`: *"no continuation is injected here, so
`resume` never claims to have re-dispatched work it did not"*). So the half of AT07 that says
*explicit resume preserves completed work* is only half-demonstrated: the work is preserved, but
resume is not a resumption — the interrupted task cannot be finished, and the eight-file
deliverable stays unfinished forever.

*No duplicate accepted writer* holds, but vacuously — nothing is ever accepted. A second resume
shows the reconciler is at least monotone about the old work:

```
$ node dist/cli/index.js resume <same run> ...
run ...: running (ownership epoch 2)
reconciled 2 attempts, 0 open operations
  preserve 01a07d16-c328-76d5-... (gen 1) — attempt is superseded; its recorded work is
    preserved and never re-run
  replace 01a07d18-5d43-... (gen 2 -> 3 as 01a07d18-5d9d-...) — no effect was dispatched and
    no worker was recorded; nothing was started for this attempt
```

Two side effects of a resume that continues nothing, both visible in the state database after the
two resumes above:

- each resume mints another empty attempt generation (1 superseded, 2 superseded, 3 pending) with
  no worker behind it;
- the run row is flipped to `running` and left there while its only task stays `cancelled`, so
  `status` afterwards describes a run that nothing is working on as running.

Files: [`logs/at07-run.txt`](logs/at07-run.txt), [`logs/at07-resume-1.txt`](logs/at07-resume-1.txt),
[`logs/at07-resume-2.txt`](logs/at07-resume-2.txt),
[`manifests/at07-result.json`](manifests/at07-result.json),
[`manifests/at07-candidate.patch`](manifests/at07-candidate.patch).

## AT09 — a fast prerequisite releases its dependent · NOT RUN (unreachable)

> *One fast prerequisite releases its dependent while an unrelated slow worker continues, when an
> active-turn slot is available.*

**Not run against real runtimes.** Two independent reasons, either of which is sufficient:

1. **Dependencies cannot be expressed.** The only way into the planned path is
   `decomposeRequest` (src/cli/commands/run.ts), which maps enumerated deliverables to tasks
   `t1..tn` and never emits a `dependencies` field. `runPlanned` accepts dependencies; no caller
   supplies them. There is no `--depends`, no plan file and no planner that emits a graph.
2. **Nothing continues while anything else runs.** A dispatched batch is executed strictly one
   task at a time (src/core/run-planned.ts:275-279, quoted in
   [`logs/static-probes.txt`](logs/static-probes.txt)), so "an unrelated slow worker continues" is
   not a state the orchestrator can be in.

The scheduler *unit* does implement the semantics AT09 asks for, which is worth recording
separately so the gap is attributed to the orchestrator and not to the scheduler
([`at09-scheduler-probe.mjs`](at09-scheduler-probe.mjs) → [`logs/at09-scheduler-unit.json`](logs/at09-scheduler-unit.json)):

```json
[ { "step": "dispatch#1", "tasks": ["fast-prereq", "slow-unrelated"], "activeTurns": 2 },
  { "step": "dispatch#2 (nothing new: caps are full)", "tasks": [] },
  { "step": "after fast-prereq completes, slow-unrelated still active", "activeTurns": 1 },
  { "step": "dispatch#3", "tasks": ["dependent"], "activeTurns": 2 } ]
```

A passing unit is not the acceptance test. AT09 remains unrun.

## Why the unit suite did not catch this

`npm test` on the same tree is **565 passed / 31 skipped, 45 files**, and `npm run typecheck` is
clean. Both were run for this record. The AT06 crash is invisible to them because the one planned
integration test that exercises a task failing to reach acceptance
(`tests/integration/planned.test.ts`, *"refuses to integrate when a task never reaches
acceptance"*) uses a worker that produces **no candidate at all**. `runTaskWithRepair` returns
early when `candidateRevision === null`, so the repair branch — the branch that inserts a second
attempt row for the same task — is never entered by any test that touches a real database.
`tests/integration-wp08/repair.test.ts` exercises `RepairSession` as a pure unit, with no storage.

## Also observed

- `request_task` (the delegation tool) validates depth and budget, persists the request and tells
  the worker it is queued. Nothing anywhere reads `task_request` messages back
  ([`logs/static-probes.txt`](logs/static-probes.txt)), so a delegated sub-task is never created.
- Two different exported functions are named `buildHandoffPacket`, in `src/routing/handoff.ts` and
  `src/recovery/fallback.ts`, with different input types.
