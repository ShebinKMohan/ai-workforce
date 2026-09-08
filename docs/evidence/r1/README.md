# R1 gate record — AT04, AT05, AT06, AT07, AT09 against real runtimes

Release gate: **R1** · Work package: **WP10 (gate)** · Recorded 8 September 2026 on the author's
macOS machine against `main` at `df2bf97` ("Fix the four R1 gate blockers"), with `dist/` built by
`npm run build` from that tree (exit 0).

This record **supersedes** the 7 September one, which is kept unchanged in
[`2026-09-07-first-gate/`](2026-09-07-first-gate/). That record found three of the five tests
unreachable from the shipped product; all five are reachable now.

**Verdict: R1 does not pass.** Four of the five acceptance tests pass end to end through the
shipped CLI. AT05 fails: the run produced exactly one coordination message, the recipient never
received or used it, and the combined candidate was rejected. Everything below is what was
executed. Where a test was not run, it says so; a test that was not run is not recorded as a pass.

| Test | Verdict | One line |
| --- | --- | --- |
| AT04 cross-runtime handoff | **PASS** | a real `authentication` failure on claude-code was handed to codex, which used the handed-over findings and was accepted (exit 0) |
| AT05 peer clarification | **FAIL** | 1 message in `messages`; the recipient had already finished when it was sent; combined candidate rejected (exit 4) |
| AT06 bounded repair | **PASS** | 1 attempt + exactly 2 repairs, budget exhaustion reported, manifest written, no crash (exit 4) |
| AT07 cancel and resume | **PASS** | SIGINT at 1 of 8 files → exit 130, no surviving group; resume finished the work and was accepted; a second resume is a no-op |
| AT09 dependency release | **PASS** | the dependent's turn started at +26.3 s while the unrelated slow task ran until +182.9 s |

## Environment

| Fact | Value |
| --- | --- |
| Runtimes | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex` (model `gpt-5.6-sol`, effort `low`); `claude 2.1.260` at `~/.local/bin/claude` (model `sonnet`, effort `low`) |
| Node | v26.8.1 · darwin 25.6.0 arm64 |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | 641 passed / 32 skipped / 0 failed, 51 files |
| Agent config | [`agents.json`](agents.json) — `maxActiveTurns` 2, `maxActiveWriters` 2, `maxRepairAttempts` 1 (2 for AT06), `maxTransientRetries` 0 |

### The Claude Code credential on this machine is expired

`workforce doctor --connect` ([`logs/doctor-connect.json`](logs/doctor-connect.json)):

```
codex        0.147.0  installed  controllable  auth logged_in   readiness verified_ready
claude-code  2.1.260  installed  controllable  auth logged_out  readiness controllable
```

Reproduced outside the product, with the same sanitized environment the adapter builds:

```
$ env -i PATH=… HOME=… claude --print --model sonnet "reply with the single word OK"
Failed to authenticate: OAuth session expired and could not be refreshed
```

This is an environment fact, not a defect in the product under test. It is load-bearing twice:
it is the genuine, unprovoked provider failure AT04 is built on, and it is why no test below
depends on Claude Code *producing* work.

## Fixtures

Throwaway Git repositories, one per test, each holding the checks it needs. All check scripts are
in [`fixtures/`](fixtures/) and all requests and plan files in [`requests/`](requests/).

- [`fixtures/check.mjs`](fixtures/check.mjs) — `lint` (every `docs/*.md` starts with `# `; passes
  at base), `strict`, `sealed`, and `always-fail` (exits 1 unconditionally, the AT06 driver).
- [`fixtures/agree.mjs`](fixtures/agree.mjs) — AT05. Passes when only one of `docs/glossary.md`
  and `docs/usage.md` is present (a single task's candidate cannot be judged) and requires the two
  to name the same word when both are present, so the check bites on the **combined** candidate.
- [`fixtures/notes.mjs`](fixtures/notes.mjs) — AT07. `docs/n01.md`..`docs/n08.md`, three lines
  each, exact title and `Status: reviewed`. Satisfiable: finishing the deliverable makes it pass.

AT07 was run twice. The first attempt used `check.mjs strict` as its acceptance check, which was a
fixture error on this gate's part: the fixture's own `docs/index.md` can never satisfy `strict`,
so no worker could have been accepted. Both runs are kept below — the first, whose check was
unsatisfiable, and the re-run with `notes.mjs`, which is the one AT07 is judged on.

---

## AT04 — cross-runtime handoff · PASS

> *A task that fails on one runtime with a classifiable provider failure is handed to the other
> via the portable packet, and the second runtime result demonstrably uses the handed-over
> contract and findings.*

Three runs, because the first provocation did not classify into a handoff class. All three are
reported; none injected a fake error.

### A. `gpt-6-astra` HTTP 400 — provoked, and it does not reach a handoff

**What was provoked:** the codex runtime was pinned to `gpt-6-astra`
([`agents-gpt-6-astra.json`](agents-gpt-6-astra.json)), the model this machine's Codex build
cannot use. The provider really answers HTTP 400:

```
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",
        "message":"The 'gpt-6-astra' model requires a newer version of Codex. …"}}
```

The run stops correctly (`EXIT=4`, not accepted, no candidate) but the failure classifies
**`unknown`**, not `protocol` ([`logs/at04a-run.txt`](logs/at04a-run.txt),
[`logs/at04-classification-events.txt`](logs/at04-classification-events.txt)):

```
runtime.failure_classified {"failureClass":"unknown","retryable":false,"signal":"none","userAction":null}
```

`unknown` is not in `HANDOFF_FAILURE_CLASSES`, so no handoff is attempted — correctly, given the
class. But the class itself is wrong: the status **400 is present verbatim in the runtime's own
error payload** and the classifier does not read it. `HTTP_STATUS_IN_RUNTIME_ERROR`
(`src/core/run-direct.ts`) matches only prose forms — `unexpected status 400`, `status code 400`,
`http 400` — and Codex 0.147.0 reports this failure as JSON (`"status":400`). Codex also attaches
no `codexErrorInfo` here, so the adapter's own `errorClass` is `unknown` too. Correctly classified
this is `protocol`, which is still not a handoff class; the defect is the lost class, not the
absent handoff. This provocation therefore cannot demonstrate AT04.

### B. A genuinely signed-out first runtime — the handoff happens

**What was provoked:** `CODEX_HOME` was pointed at an empty directory for the coordinator process
only. `CODEX_HOME` is in the codex adapter's inherited-environment allowlist and is *not* in the
Claude Code one, so the codex worker really has no credential and the claude worker is untouched.
The provider answers 401 for real. Nothing was stubbed and no error was injected.

```
$ CODEX_HOME=<empty dir> node dist/cli/index.js run --repo <fixture> --agents agents.json \
    --path direct --task-file at04-request.txt --check "node scripts/check.mjs lint" \
    --allow-unconfined-writes --state-dir <state> --workspace-root <ws>
  runtime error: {"message":"unexpected status 401 Unauthorized: Missing bearer or basic
                  authentication in header, url: https://api.openai.com/v1/responses, …"}
runtime.failure_classified {"failureClass":"authentication","signal":"HTTP 401", …}
runtime.fallback_selected  {"fromRuntimeId":"codex-local","toRuntimeId":"claude-local",
                            "failureClass":"authentication", …}
… agent engineer-claude via claude-local (claude-code)   [generation 2, prompt 3792 chars]
  runtime error: {"message":"Failed to authenticate: OAuth session expired …",
                  "errorClass":"authentication","runtimeError":"authentication_failed"}
EXIT=4
```

The handoff mechanism worked; the target could not, because Claude Code is signed out on this
machine. [`logs/at04b-run.txt`](logs/at04b-run.txt), [`manifests/at04b-result.json`](manifests/at04b-result.json).

### C. The decisive direction — signed-out runtime first, working runtime second · **this is the pass**

**What was provoked: nothing.** The first runtime is Claude Code, whose OAuth session is genuinely
expired (see Environment). The request
([`requests/at04c-request.txt`](requests/at04c-request.txt)) asks the worker to write, on line 2 of
`docs/handoff.md`, the failure class and runtime id of the previous attempt *exactly as its own
briefing states them*, and to write `Continued after: none` if it was given no such section. Those
two facts appear nowhere in the request and nowhere in the repository.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json --agent engineer-claude \
    --path direct --task-file at04c-request.txt --check "node scripts/check.mjs lint" \
    --allow-unconfined-writes --state-dir <state> --workspace-root <ws>
agent engineer-claude via claude-local (claude-code)
not accepted: … error class "authentication", result text "Failed to authenticate: OAuth session
              expired and could not be refreshed"
agent engineer-codex via codex-local (codex)
  check check-1: passed (exit 0) in 41ms
runtime fallback: claude-local (claude-code) -> codex-local (codex) after a authentication failure
run 01a07ead-dda3-71dc-8cbd-f404621708f3: accepted
EXIT=0
```

The brief the second runtime received ([`logs/at04c-handoff-brief.txt`](logs/at04c-handoff-brief.txt))
carries the packet's contents verbatim — original request, task contract (version 1), base and
candidate revisions, patch state, executed checks, scope limits, and:

```
## Findings from the previous attempt
- [info] the previous attempt stopped with a authentication failure on runtime "claude-local"
  (claude-code); it is being continued on "codex-local" (codex) (request:attempt:01a07ead-…)
```

and what it produced ([`manifests/at04c-candidate.patch`](manifests/at04c-candidate.patch)):

```
+# Handoff
+Continued after: authentication failure on claude-local
```

That line can only have come from the handed-over findings. **AT04 passes.**

### Two defects found while passing it

1. **The portable packet is never persisted.** `runWithFallback` writes it to
   `<runDir>/handoff/<attemptId>.json` with `writeFileSync` and no `mkdirSync`
   (`src/recovery/continue.ts:96-105`), so the write throws `ENOENT` and is swallowed by the
   `catch`; `packetPath` becomes `null` and nothing says so. The directory is absent in both runs
   that selected a handoff ([`logs/at04-packet-not-persisted.txt`](logs/at04-packet-not-persisted.txt)).
   The packet is built, validated and transported in memory — which is why AT04 passes — but the
   artifact AT04 calls "the portable packet" is not on disk and not in the manifest.
2. **The fallback selector asserts a readiness it never established.** `candidatesFrom`
   (`src/recovery/continue.ts:163-181`) hardcodes `ready: 'verified_ready'` for every configured
   runtime, so run B's event records `"reason":"claude-local (claude-code) is configured, verified
   ready and permitted …"` for a runtime `doctor --connect` reports as `logged_out` in the same
   session. The handoff to a signed-out runtime is defensible when there is no other candidate;
   the sentence claiming it was verified is not.

---

## AT05 — peer clarification · FAIL

> *A planned two-worker run where one worker needs something only the other knows.*

Plan ([`requests/at05-plan.json`](requests/at05-plan.json)): two tasks, **no dependency between
them**, so they run at the same time. `t1` invents a word freely and is told to answer a peer that
asks for it; `t2` must write that exact word and is told the only way to learn it is
`send_message` to `t1`'s task id followed by `read_inbox`. The word is in no file and in neither
worker's own instructions. Acceptance adds [`fixtures/agree.mjs`](fixtures/agree.mjs), which
forces the two deliverables to name the same word on the combined candidate.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json \
    --plan at05-plan.json --task-file at05-request.txt \
    --check "node scripts/check.mjs lint" --check "node scripts/agree.mjs" \
    --state-dir <state> --workspace-root <ws>
EXIT=4
```

### The three numbers AT05 asks for

**Coordination messages in the `messages` table: 1.**
([`logs/at05-messages.txt`](logs/at05-messages.txt))

```json
{"sender_task_id":"…-bf2d-7373-…","recipient_task_id":"…-bf2d-7374-…","type":"peer_message",
 "body_json":"{\"subject\":\"Chosen word\",\"text\":\"lantern\"}",
 "delivery_state":"submitted","created_at":"2026-09-08T01:45:42.160Z","acknowledged_at":null}
```

**Did a recipient demonstrably use one? No.** `t2` wrote `Uses term: unanswered`.

**Did the combined candidate pass? No.**

```
integrating 2 approved artifact(s) and re-running the checks against the combined revision
  combined check check-1: passed (exit 0)
  combined check check-2: failed (exit 1)
not accepted: the combined candidate is not established: "check-2" reported "failed" against the
              combined revision 631900d4a8b6…
```

### What actually happened, measured

| Time (UTC) | Event |
| --- | --- |
| 01:44:03.5 | both workers' turns start — genuinely concurrent |
| 01:44:57.7 | **t2's turn completes**, having written `Uses term: unanswered` |
| 01:45:42.2 | t1 sends its answer (`lantern`) to t2 — 45 s after t2 stopped |
| 01:46:41.9 | t1's turn completes |

The coordination context was correct: t2's prompt named t1's task id and told it how to address it
(`logs/at05-run.txt`; the section is quoted in the run log). t2 never called `send_message` or
`read_inbox` — it used an unrelated `wait` tool from the operator's own Codex MCP configuration and
reported *"The coordinator-provided t1 ID is not reachable in the current agent mailbox, and no
peer inbox is exposed here"*, which is not true of this run. That half is worker behaviour on one
sample, not a product defect, and one run is one sample.

The product defect underneath it is separate and is not sample-dependent: **a peer message is
accepted, stored and reported as sent even when the recipient has no live attempt, and is then
never delivered.** t1's `send_message` succeeded 45 seconds after t2's only attempt had ended. The
row's `delivery_state` is still `submitted`, `acknowledged_at` is still null, and the run's event
log contains **no `coordination.delivered` and no `coordination.delivery_failed` event at all** —
only the two `coordination.attached` records. Nothing told the sender its peer was gone and the
run's `unresolved` list does not mention an undelivered message.

The coordinator pushes messages at exactly two points, both bounded by the *recipient's own*
attempt (`src/core/run-direct.ts`): into the prompt at composition time (line 1232), and through
`adapter.deliver` **after the recipient's turn event stream is exhausted** (line 1294, commented
"a safe boundary after the turn"). The codex adapter's `turn/steer` path exists and is verified,
but the coordinator only reaches it once the turn it would steer has already ended. For a
single-turn worker that means a peer's answer can never influence the recipient's output, and a
message that arrives after the recipient's attempt has ended — this run's case — is not delivered
at all. Everything therefore rests on the recipient choosing to poll `read_inbox` before it
finishes, which is exactly what did not happen here.

---

## AT06 — bounded repair · PASS

> *A deliberately unsatisfiable check drives repair, stops at maxRepairAttempts, reports the budget
> exhausted, writes a manifest, no crash.*

`maxRepairAttempts: 2` ([`agents-maxrepair2.json`](agents-maxrepair2.json)); the unsatisfiable
check is `node scripts/check.mjs always-fail`, which exits 1 unconditionally — nothing a worker
writes can satisfy it, and it says so on stderr rather than looking fixable.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents-maxrepair2.json \
    --plan at06-plan.json --task-file at06-request.txt \
    --check "node scripts/check.mjs lint" --check "node scripts/check.mjs always-fail" …

  check check-1: passed (exit 0)   check check-2: failed (exit 1)
not accepted: criterion "check-2" failed with exit 1
task "t1" (repair 1): …
  check check-1: passed (exit 0)   check check-2: failed (exit 1)
task "t1" (repair 2): …
  check check-1: passed (exit 0)   check check-2: failed (exit 1)
task "t1": repair budget exhausted after 2 repair(s); the repair budget for task 01a07eb4-… is
           exhausted after 2 repair attempt(s) (limit 2); 1 check(s) still fail against b15e8f5f9164
not accepted: task "t1" did not reach acceptance, so there was nothing to integrate
run 01a07eb4-2c42-7230-98c0-435bde2dc368: failed (planned, 1 tasks)
  FAIL t1: … (after 2 repair(s))
EXIT=4
```

Exactly one initial attempt and exactly two repairs; the budget is reported with its limit, its
count and the revision the checks still fail against. Three distinct attempt generations exist and
the run reached `finish()`:

```
{"gen":1,"state":"superseded"}  {"gen":2,"state":"superseded"}  {"gen":3,"state":"completed"}
```

The manifest [`manifests/at06-planned-result.json`](manifests/at06-planned-result.json) was written
at `<runDir>/planned-result.json`. No crash: the 7 September record's
`UNIQUE constraint failed: attempts.task_id, attempts.generation` did not recur.
[`logs/at06-run.txt`](logs/at06-run.txt).

**Minor defect observed here.** The planned path prints
`artifacts: <runDir>/artifacts` followed by `result.json · summary.md · candidate.patch · checks/ · logs/`,
but on the planned path that directory contains only `checks/`, `logs/` and `tasks/`; the three
named files exist per attempt under `artifacts/tasks/<attemptId>/`, and the run-level manifest is
`<runDir>/planned-result.json`, which the line never names. The direct path's copy of this line is
accurate.

---

## AT07 — cancel and resume · PASS

> *SIGINT mid-turn (exit 130, no surviving process group), then resume drives the run to a terminal
> state with prior work preserved and no duplicate accepted writer.*

Eight files, written one at a time; the driver
([`fixtures/at07-interrupt-driver.sh`](fixtures/at07-interrupt-driver.sh)) polls the candidate
worktree every 200 ms and sends `SIGINT` the moment between one and seven of the eight exist, so
the interrupt lands with the deliverable genuinely half-written.

### Cancellation

```
candidate workspace observed at 2026-09-08T01:55:18.3Z
observed 1 of 8 note file(s) in the candidate at 2026-09-08T01:55:46.3Z
index.md n01.md
coordinator child pids before SIGINT: 81291
sending SIGINT to 81134 at 2026-09-08T01:55:46.3Z
EXIT=130
```

```
interrupt requested: stopping the worker and preserving what exists
  turn interrupted
  the runtime acknowledged the interruption and ended the turn
worker stopped: process_tree_terminated
candidate f1352a6f155d on workforce/…: 1 changed file(s), patch 02d4fe1146d5
interrupted: work preserved on the candidate branch, nothing accepted
```

No surviving process group ([`logs/at07b-process-group.txt`](logs/at07b-process-group.txt)):
coordinator 81134 gone, worker 81291 gone, `ps -eo pid,pgid | awk '$2==81291'` and `$2==81134`
both empty. The one written file is a real checkpoint commit on the gen-1 candidate branch, and
nothing was accepted.

### Resume

```
$ node dist/cli/index.js resume 01a07eba-11a6-76f7-82ac-f7ba7dc8396e --agents agents.json --state-dir <state>
continuing task 01a07eba-11a6-76f8-b66e-a6d4e47b2400 as attempt 01a07eba-b1bf-73da-9ef1-74f6e53dbad3 (generation 2)
…
  check check-1: passed (exit 0) in 36ms
accepted: 1/1 required criteria passed with verifier-executed evidence
  replace 01a07eba-11a6-76f9-… (gen 1 -> 2 as 01a07eba-b1bf-…) — the recorded worker process 81291
    is gone; session … cannot be rejoined, so a new generation may take over
task 01a07eba-11a6-76f8-…: accepted (attempt 01a07eba-b1bf-…, generation 2)
run 01a07eba-11a6-76f7-…: ready_for_review
EXIT=0
```

`resume` continues the run rather than reporting a plan and stopping — the 7 September finding is
fixed. The run reaches the terminal state `ready_for_review`.

**Prior work preserved:** both candidate branches survive in the fixture repository, gen 1 still
holding its checkpoint commit for `docs/n01.md`. The continuation is explicit about what that
means, in its own briefing:

> *"A previous attempt (…, generation 1) was stopped before it finished. Whatever it recorded is
> preserved as evidence of that attempt and is not carried into yours. Your workspace starts from
> the same committed base revision as that attempt did …"*

So the partial work is preserved as evidence and the objective is redone from base, and the
product says so rather than implying continuity it does not provide.

**No duplicate accepted writer:** one accepted attempt (gen 2, `completed`); gen 1 is `superseded`.
A second `resume` on the terminal run creates no attempt at all
([`logs/at07b-resume-2.txt`](logs/at07b-resume-2.txt)):

```
run …: ready_for_review (ownership epoch 1)
reconciled 2 attempts, 0 open operations
  preserve … (gen 1) — run already ready_for_review; recorded work is preserved
  preserve … (gen 2) — run already ready_for_review; recorded work is preserved
run … already reached ready_for_review; nothing to resume and recorded work is preserved
EXIT=0
```

The earlier attempt with the broken `strict` fixture is kept for completeness
([`logs/at07-run.txt`](logs/at07-run.txt), [`logs/at07-resume-1.txt`](logs/at07-resume-1.txt));
there, resume also continued the run correctly and the check failed on the fixture's own
`docs/index.md`, not on the worker's output.

---

## AT09 — dependency release · PASS

> *A plan with fast, dependent(fast) and an unrelated slow task; did the dependent start WHILE the
> slow task was still running?*

Plan ([`requests/at09-plan.json`](requests/at09-plan.json)): `fast` (no dependencies), `dependent`
(`["fast"]`), `slow` (no dependencies; it must run `sleep 150` before writing anything).
`maxActiveTurns` and `maxActiveWriters` are both 2, so at most two tasks can be in a turn at once.

Measured from the run's own event timestamps, `t0` = first `task.created`
([`logs/at09-timeline.txt`](logs/at09-timeline.txt)):

```
+   0.0s  task.created           fast
+   0.0s  task.created           slow
+   3.3s  turn.started           fast
+   3.3s  turn.started           slow
+  24.4s  runtime.turn_completed fast
+  25.5s  runtime.stopped        fast
+  25.8s  task.created           dependent
+  26.3s  turn.started           dependent      <-- released here
+  45.4s  runtime.turn_completed dependent
+  46.5s  runtime.stopped        dependent
+ 182.9s  runtime.turn_completed slow           <-- slow was still running the whole time
+ 183.0s  runtime.stopped        slow
```

**Yes. The dependent started while the unrelated slow task was still running** — its turn began at
+26.3 s and `slow` did not finish until +182.9 s, so the dependent both started and finished
(+45.4 s) inside the slow task's turn, with 156.6 s to spare. The slot it used was the one `fast`
released 0.8 s earlier; the cap of two active turns was respected throughout.

The dependent also consumed its prerequisite's artifact rather than the base repository — `fast`
wrote `Token: harbour`, and `dependent` wrote `# Dependent` / `Token: harbour`. The combined
candidate `36bcb05565fe` passed the re-run check and the run was accepted, `EXIT=0`.
[`logs/at09-run.txt`](logs/at09-run.txt),
[`manifests/at09-planned-result.json`](manifests/at09-planned-result.json).

---

## Defects this gate found

| # | Severity | Defect |
| --- | --- | --- |
| 1 | blocking | AT05: a peer message is only ever pushed at the recipient's prompt composition or *after* the recipient's turn stream ends (`src/core/run-direct.ts:1232`, `:1294`), so `turn/steer` is never used while the turn it would steer is running; a message that arrives after the recipient's attempt has ended is not delivered at all. `delivery_state` stays `submitted` for ever, no `coordination.delivered`/`delivery_failed` event is written, the sender is told nothing, and the run's `unresolved` list does not mention it. |
| 2 | major | The portable handoff packet is never written: `<runDir>/handoff/` is never created, so `writeFileSync` throws `ENOENT` into a silent `catch` (`src/recovery/continue.ts:96-105`). |
| 3 | major | Codex's HTTP 400 is classified `unknown`: the status is present as `"status":400` in the runtime's own error payload, but `HTTP_STATUS_IN_RUNTIME_ERROR` (`src/core/run-direct.ts`) only matches prose forms such as `unexpected status 400`. |
| 4 | major | `candidatesFrom` (`src/recovery/continue.ts:163-181`) hardcodes `ready: 'verified_ready'`, so a fallback event says a runtime is "configured, verified ready" when `doctor --connect` reports it `logged_out`. |
| 5 | minor | The planned path prints `artifacts: <runDir>/artifacts` with `result.json · summary.md · candidate.patch`, none of which are in that directory on the planned path; the run manifest `planned-result.json` is not named. |
| 6 | minor | When a failure is classified into a non-handoff class, `runWithFallback`'s explanatory `note` is computed and then dropped, because the CLI only prints it when `fallback !== null` (`src/cli/commands/run.ts:270-274`). Run A says nothing at all about why no handoff was attempted. |
