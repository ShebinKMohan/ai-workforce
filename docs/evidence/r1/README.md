# R1 gate record — fourth gate: AT05 end to end, and AT02, AT04, AT06, AT07, AT09 re-run

Release gate: **R1** · Work package: **WP10 (gate)** · Recorded 8 September 2026 on the author's
macOS machine against `main` at `ee5581d` ("Deliver or fail every peer message, and stop the
acceptance surface refusing what it cannot analyse"), with `dist/` built by `npm run build` from
that tree (exit 0) and the working tree clean before and after every run.

Everything in this record was executed against **real runtimes through the shipped CLI**
(`node dist/cli/index.js`). No fake runtime, no replay fixture, no unit test stands in for any
verdict here. The deterministic half of the R1 suite (AT08, AT10, AT11, AT12, AT13, AT14, AT15) was
**not re-run this round**; its record is preserved unchanged in
[`2026-09-08-third-gate-deterministic/`](2026-09-08-third-gate-deterministic/) — apart from its
relative links, repointed one directory up so they still resolve. Earlier records:
[`2026-09-08-third-gate/`](2026-09-08-third-gate/),
[`2026-09-08-second-gate/`](2026-09-08-second-gate/),
[`2026-09-07-first-gate/`](2026-09-07-first-gate/). Everything new here is in
[`2026-09-08-fourth-gate/`](2026-09-08-fourth-gate/).

## Verdict

| Test | Verdict | One line |
| --- | --- | --- |
| **AT05 peer clarification** | **PASS, intermittently** | 3 of 4 concurrent runs passed end to end: 2 message rows each, both `acknowledged`, both delivered `submitted_to_active_turn`, readable text, and the peer's invented codename reached the recipient **only** through the coordinator's push. The 4th failed and is explained below — a tool-name collision on the runtime, not a coordination defect, but a real defect all the same |
| **AT05 recipient already finished** | **PASS** | the send is refused `recipient_finished`, the row is `rejected`, a `coordination.delivery_failed` event is written, the sender's tool call **fails**, and the run prints and records an `unresolved` entry. Nothing is reported as sent that was never delivered |
| AT02 one verified change | **PASS** | the fixture bug reproduces at base, the worker fixes it, the frozen candidate passes `node --test test/` under the verifier, run accepted (exit 0), the original checkout is byte-unchanged |
| AT04 cross-runtime handoff | **PASS** | Claude Code's genuinely expired OAuth session was classified `authentication`, the configured fallback ran, and the second runtime wrote a line it could only have got from the handed-over findings |
| AT06 bounded repair | **PASS** | 1 initial attempt + exactly 2 repairs, budget reported with its limit and the revision the checks still fail against, 3 attempt generations, manifest written, no crash (exit 4) |
| AT07 cancel and resume | **PASS** | SIGINT mid-turn → exit 130, no surviving process group; resume drove the run to `ready_for_review` with the gen-1 branch preserved and one accepted writer; a second resume created no attempt |
| AT09 dependency release | **PASS** | the dependent both started (+16.7 s) and finished (+31.7 s) while the unrelated slow task was still running (+174.4 s) |

**R1 passes on this evidence.** The two defects this round targeted — a peer message that reached a
recipient's live turn as `[object Object]` or not at all, and a message to a finished recipient
accepted and then silently dropped — are both fixed and both demonstrated end to end. One new major
defect was found while proving it (below), and two carried-forward defects were re-confirmed.

## Environment

| Fact | Value |
| --- | --- |
| Revision under test | `ee5581d746336dd092218a143da68ea5b171b1eb` on `main`, working tree clean |
| Node | v26.8.1 · darwin 25.6.0 arm64 |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 ([`logs/npm-typecheck.txt`](2026-09-08-fourth-gate/logs/npm-typecheck.txt)) |
| `npm test` | 763 passed / 32 skipped / 0 failed, 59 files ([`logs/npm-test.txt`](2026-09-08-fourth-gate/logs/npm-test.txt)) |
| codex | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex` — `auth: logged_in`, `readiness: verified_ready`. Model pinned to `gpt-5.6-sol`; this machine's default `gpt-6-astra` is rejected with HTTP 400 |
| Claude Code | `claude 2.1.260` at `~/.local/bin/claude` — **`auth: logged_out`**. Its OAuth session is expired: the runtime itself reports `account.tokenSource: "none"`. That is not worked around anywhere in this record; it is exactly what AT04 provokes, and it is why every other test here runs on codex |
| doctor | [`logs/doctor-connect.json`](2026-09-08-fourth-gate/logs/doctor-connect.json) |
| fixture base revisions | [`logs/fixture-bases.txt`](2026-09-08-fourth-gate/logs/fixture-bases.txt) |

Fixture repositories are throwaway Git repos built by
[`fixtures/mkfixture.sh`](2026-09-08-fourth-gate/fixtures/mkfixture.sh) — `docs/index.md` plus the
check scripts. AT02 uses the shipped `fixtures/ts-bug`, materialized by `fixtures/materialize.ts`
into its own copy, so the fixture in this repository is never touched. Agent configuration:
[`agents.json`](2026-09-08-fourth-gate/agents.json) (both runtimes, `maxRepairAttempts: 1`),
[`agents-maxrepair2.json`](2026-09-08-fourth-gate/agents-maxrepair2.json) for AT06,
[`agents-at02.json`](2026-09-08-fourth-gate/agents-at02.json) for AT02.

---

## AT05 — peer clarification · PASS, intermittently

> *Two isolated workers exchange an actual peer clarification without a manager-model relay; the
> combined candidate passes.*

The plan ([`requests/at05-plan.json`](2026-09-08-fourth-gate/requests/at05-plan.json)) is two tasks
with **no dependency between them**, so they run at the same time. `t1` invents a codename freely
and answers the peer that asks for it; `t2` must write that exact codename and is told that guessing
is a failure. Each worker learns its own task id and its peer's only from the coordinator's own
`--- coordination ---` prompt section. The codename is in no file. Acceptance adds
[`fixtures/agree.mjs`](2026-09-08-fourth-gate/fixtures/agree.mjs), which forces the two deliverables
to name the same word on the **combined** candidate.

```
$ node dist/cli/index.js run --repo <fixture> --agents agents.json \
    --plan at05-plan.json --task-file at05-request.txt \
    --check "node scripts/check.mjs lint" --check "node scripts/agree.mjs" \
    --state-dir <state> --workspace-root <ws>
```

Four runs, because this test has been intermittent before. Per run:

| | run 1 | run 2 | run 3 | run 4 |
| --- | --- | --- | --- | --- |
| run id | `01a0821f-e0e3-…` | `01a08221-3338-…` | `01a08222-c1e6-…` | `01a08233-2c65-…` |
| message rows | **2** | **2** | **0** | **2** |
| final delivery states | `acknowledged`, `acknowledged` | `acknowledged`, `acknowledged` | — | `acknowledged`, `acknowledged` |
| delivered text readable | yes | yes | — | yes |
| active turn or queued | `submitted_to_active_turn` (holder `runtime`) ×2 | same ×2 | — | same ×2 |
| recipient used the fact | yes — `verdant` | yes — `velvet` | **no** | yes — `cobalt` |
| combined candidate | **passed**, exit 0 | **passed**, exit 0 | **failed** `check-2`, exit 4 | **passed**, exit 0 |
| log | [`at05r1-run.txt`](2026-09-08-fourth-gate/logs/at05r1-run.txt) | [`at05r2-run.txt`](2026-09-08-fourth-gate/logs/at05r2-run.txt) | [`at05r3-run.txt`](2026-09-08-fourth-gate/logs/at05r3-run.txt) | [`at05r4-run.txt`](2026-09-08-fourth-gate/logs/at05r4-run.txt) |

### 1. The rows, and where they ended

Run 1's whole `messages` table
([`at05r1-evidence.txt`](2026-09-08-fourth-gate/logs/at05r1-evidence.txt)), abbreviated:

```json
{"sender_task_id":"…-755f-…","recipient_task_id":"…-755e-…","type":"peer_message",
 "body_json":"{\"text\":\"Please reply with the codename you invented.\"}",
 "delivery_state":"acknowledged","created_at":"…T17:45:49.283Z","acknowledged_at":"…T17:45:49.285Z"}
{"sender_task_id":"…-755e-…","recipient_task_id":"…-755f-…","type":"peer_message",
 "body_json":"{\"text\":\"verdant\"}",
 "delivery_state":"acknowledged","created_at":"…T17:46:10.262Z","acknowledged_at":"…T17:46:10.263Z"}
```

One question, one answer, both `acknowledged`. Runs 2 and 4 are the same shape. No row in any of the
four runs finished at `submitted`.

### 2. The delivered text was readable

Not a log line the coordinator wrote about itself — the adapters' own raw capture of the JSON-RPC
they sent:

```json
{"jsonrpc":"2.0","id":4,"method":"turn/steer","params":{
  "threadId":"01a0821f-e641-73b1-90fc-59569135da93",
  "expectedTurnId":"01a0821f-e6fa-7cc1-bd99-71a16b4eb983",
  "input":[{"type":"text","text":"[coordinator message 01a08220-9bd6-…]\n[peer_message from 01a0821f-e0e6-755e-…] verdant"}]}}
```

and in the other direction, with the subject rendered ahead of the text as `renderMessageBody`
intends:

```
[coordinator message 01a08221-aad5-…]
[peer_message from 01a08221-333b-70ed-…] Codename request: Please reply with the codename you invented.
```

`[object Object]` — what every body was before `92c4516` — occurs **0 times** in the raw captures of
all four runs.

### 3. Active-turn path, not queued

Every delivery in runs 1, 2 and 4 recorded
`{"state":"submitted_to_active_turn","holder":"runtime","turnId":"…"}`, and the matching `turn/steer`
carries `expectedTurnId`. There is not one `queued` delivery and not one `coordination.delivery_failed`
in those three runs.

### 4. The recipient demonstrably used the fact — and the push was the only channel

The strongest evidence in this record, and stronger than the third gate's. Classifying every frame in
the **recipient's** raw capture that contains the codename
([`fixtures/word-frames.mjs`](2026-09-08-fourth-gate/fixtures/word-frames.mjs)):

```
run 1, t2's session — 13 frames contain "verdant"
   out atMs=47653 turn/steer          <-- the FIRST one. Nothing carries it earlier.
   in  atMs=51726 item/started   userMessage
   in  atMs=57673 item/started   fileChange
   …
run 2, t2's session — first carrier: out atMs=43584 turn/steer
run 4, t2's session — first carrier: out atMs=37583 turn/steer
```

No `read_inbox` result and no other frame carried the word before the coordinator pushed it into the
live turn. In the third gate the recipient's own `read_inbox` had returned the same body 1 ms
earlier, so the push could not be isolated; here it can. The deliverables:

```
docs/glossary.md          docs/usage.md
+# Glossary               +# Usage
+Term: verdant            +Uses term: verdant
```

`verdant`, `velvet` and `cobalt` are each absent from the plan, from the request, from their
fixture repository at its base revision, and from this product's `src/`, `tests/` and `fixtures/`
([`at05r1-codename-provenance.txt`](2026-09-08-fourth-gate/logs/at05r1-codename-provenance.txt),
[r2](2026-09-08-fourth-gate/logs/at05r2-codename-provenance.txt),
[r4](2026-09-08-fourth-gate/logs/at05r4-codename-provenance.txt)). Each was invented at run time and
could only have reached the other worker through the coordination channel.

### 5. The combined candidate

```
integrating 2 approved artifact(s) and re-running the checks against the combined revision
  combined check check-1: passed (exit 0)
  combined check check-2: passed (exit 0)
accepted: the combined candidate 5d23b455206e passed every required criterion with verifier-executed evidence
EXIT=0
```

`check-2` is `agree.mjs`, which can only pass because the two files name the same invented word.

### Why run 3 failed — a tool-name collision, and the third gate's "confabulation" verdict was wrong

Run 3 produced **0** message rows, `t2` wrote `Uses term: unanswered`, the combined `check-2` failed
and the run was **not** accepted (exit 4). `t2` had said, 15.7 s in:

> *"The required message call was attempted first, but the coordinator reports that t1's task ID is
> not currently available."*

The third-gate record saw that sentence four times and concluded the worker was confabulating,
because its session showed zero `mcpToolCall` items. That conclusion was wrong. The worker really did
call a tool named `send_message`; it was the **wrong one**. From `t2`'s own raw capture
([`at05-tool-name-collision.txt`](2026-09-08-fourth-gate/logs/at05-tool-name-collision.txt)):

```
ERROR codex_core::tools::router: error=agent with id 01a08222-c1e9-77d3-886b-028da69a3e13 not found
```

That id is `t1`'s **task id**, exactly as the coordinator gave it. `codex-cli` 0.147.0 ships its own
built-in collaboration tool of the same name — `core/src/tools/handlers/multi_agents_v2/send_message.rs`,
advertised in the binary as *"send_message — Send a message to an existing agent"* under
`functions.collaboration` — and the coordinator's prompt asks for it unqualified
(`src/core/run-direct.ts:833`: *"call send_message with `to` set to that task id"*). When the model
resolves that name to the runtime's tool instead of the `workforce` MCP tool, the peer message never
reaches the coordinator: no row, no event, no line in the run. The same error appears in the first
attempt at the finished-recipient case, below. This is a product defect, listed as #1 below.

## AT05 — the case that broke it: the recipient finishes BEFORE the question arrives · PASS

Made deterministic rather than raced: a two-task plan where `late` **depends on** `early`
([`requests/at05-late2-plan.json`](2026-09-08-fourth-gate/requests/at05-late2-plan.json)), so
`early` is already `accepted` — turn over, session gone, checks run — before `late` starts and asks
it a question. `late` is told to name the `workforce` MCP tool explicitly, because of defect #1.

Run `01a0822a-f8d8-74f4-a4bf-eb51c5646042`,
[`at05late2-run.txt`](2026-09-08-fourth-gate/logs/at05late2-run.txt). Four things happened, and all
four are what the fix promised:

**1. The sender's tool call failed. It was not told the message was on its way.**

```
  tool send_message
coordination: a message from 01a0822a-f8dc-719c-… to 01a0822a-f8dc-719b-… was refused: task
"01a0822a-f8dc-719b-…" has already finished (accepted); it has no worker session, so this message
was not accepted for delivery. Whatever that task produced is already recorded — do not wait for an
answer; continue with what you can establish yourself and say in your own result what you could not learn.
  tool send_message -> failed
```

**2. The row is terminal and says why** ([`at05late2-evidence.txt`](2026-09-08-fourth-gate/logs/at05late2-evidence.txt)):

```json
{"body_json":"{\"subject\":\"Late question\",\"text\":\"Please confirm your status.\",
  \"undeliverable\":true,\"code\":\"recipient_finished\",\"recipientTaskState\":\"accepted\"}",
 "delivery_state":"rejected","submitted_at":null,"acknowledged_at":null}
```

`rejected`, never `submitted`. Compare the third gate, where the equivalent row sat at `submitted`
with `acknowledged_at: null` for ever.

**3. The run wrote the event and put it in front of the operator.**

```json
{"type":"coordination.delivery_failed","payload":{"messageId":"01a0822b-9646-…",
 "code":"recipient_finished","deliveryState":"rejected", …}}
```

```
unresolved:
  - a coordination message (01a0822b-9646-…) from 01a0822a-f8dc-719c-… to 01a0822a-f8dc-719b-…
    was never delivered (recipient_finished): task "…" has already finished (accepted); …
```

The same line is in the run manifest
([`at05late2-planned-result.json`](2026-09-08-fourth-gate/manifests/at05late2-planned-result.json)).

**4. The worker acted on the truth.** Its deliverable is
`Send result: recipient_finished`, and the run still reached a terminal state — accepted, exit 0.
A refused message is a fact the run reports, not a crash.

The **first** attempt at this case
([`at05late-run.txt`](2026-09-08-fourth-gate/logs/at05late-run.txt), run
`01a08228-50f0-707c-a3b0-acbfe098b167`) is kept because it failed to test what it set out to test:
the worker's `send_message` went to the codex built-in, got `agent with id … not found`, and the
coordinator recorded 0 rows. It is the second independent sighting of defect #1, and a reminder that
a test which never reached the code under test is not a pass.

---

## AT02 — one verified change · PASS

Run `01a0822c-4014-71c4-8ba7-8de4aec8cc6d`, [`at02-run.txt`](2026-09-08-fourth-gate/logs/at02-run.txt).
The `ts-bug` fixture materialized to base `d9a1b6f35b46`; `node --test test/` at base **fails** with
`actual: ['a','b','d','e'], expected: ['a'…'g']`, so the bug is real before the run. No `--check` was
passed: the criterion came from `.workforce/checks.json` **at the base revision**, and the surface
resolved from the module graph without any conservative fallback:

```
acceptance: 1 check(s) from .workforce/checks.json at base d9a1b6f35b46
acceptance fixtures (the worker must not rewrite these; new test files are fine): .workforce/checks.json, test, test/pagination.test.js
acceptance also executes 1 file(s) the worker is free to change (the code under test); each change to one is recorded in the run manifest
```

The worker changed one file, `src/pagination.js` — `Math.floor` → `Math.ceil` and the `- 1` removed
from the slice end ([`at02-candidate.patch`](2026-09-08-fourth-gate/manifests/at02-candidate.patch)) —
and `node-tests-pass` passed exit 0 in 82 ms against the frozen candidate `109e3b9f608a`, exit 0.
Afterwards the fixture checkout is unchanged: `git status --short` empty, `HEAD` still
`d9a1b6f35b462896685768feb489380d63e9b7bc`.

## AT04 — cross-runtime handoff · PASS

Run `01a0822e-a52e-7254-853d-98dfe31ebc54`, [`at04-run.txt`](2026-09-08-fourth-gate/logs/at04-run.txt).
**Nothing was injected.** The first runtime is Claude Code, whose OAuth session is genuinely expired:

```
not accepted: the runtime's own terminal record says the turn failed (… error class "authentication",
result text "Failed to authenticate: OAuth session expired and could not be refreshed"); a candidate
produced by a failed turn is not accepted, whatever the checks report
```

```json
{"type":"runtime.failure_classified","payload":{"failureClass":"authentication","retryable":false,
  "signal":"runtime tag \"authentication_failed\""}}
{"type":"runtime.fallback_selected","payload":{"fromRuntimeId":"claude-local","toRuntimeId":"codex-local",
  "failureClass":"authentication","reason":"codex-local (codex) is configured, verified ready and permitted …"}}
```

The second runtime wrote
([`at04-candidate.patch`](2026-09-08-fourth-gate/manifests/at04-candidate.patch)):

```
+# Handoff
+Continued after: authentication failure on claude-local
```

Neither `authentication` nor `claude-local` appears in the request or in the fixture at its base
revision (both greps return 0), so that line can only have come from the handed-over findings.
Exit 0. **The packet is still not persisted:** `<runDir>/handoff/` does not exist after the run.

## AT06 — bounded repair · PASS

Run `01a0822c-3c52-7335-ae22-79bfb132efcb`, `maxRepairAttempts: 2`, unsatisfiable check
`node scripts/check.mjs always-fail` ([`at06-run.txt`](2026-09-08-fourth-gate/logs/at06-run.txt)).
Nothing injected: the worker really does satisfy `check-1` every time and really cannot satisfy
`check-2`.

```
task "t1": repair budget exhausted after 2 repair(s); the repair budget for task 01a0822c-3c55-70ce-…
           is exhausted after 2 repair attempt(s) (limit 2); 1 check(s) still fail against e722de281883
not accepted: task "t1" did not reach acceptance, so there was nothing to integrate
EXIT=4
```

Exactly one initial attempt and exactly two repairs; three attempt generations
(`gen 1 superseded`, `gen 2 superseded`, `gen 3 completed`); the manifest
[`at06-planned-result.json`](2026-09-08-fourth-gate/manifests/at06-planned-result.json) was written.
No crash.

## AT07 — cancel and resume · PASS

Driver [`at07-interrupt-driver.sh`](2026-09-08-fourth-gate/fixtures/at07-interrupt-driver.sh) polls
the candidate worktree every 200 ms and sends `SIGINT` while the eight-file deliverable is genuinely
half-written ([`at07-interrupt-timeline.txt`](2026-09-08-fourth-gate/logs/at07-interrupt-timeline.txt)):

```
observed 1 of 8 note file(s) in the candidate at 2026-09-08T18:05:16.3Z
coordinator child pids before SIGINT: 61141
sending SIGINT to 60958 · EXIT=130
```

```
interrupted: work preserved on the candidate branch, nothing accepted
run 01a08231-9ca5-71e2-…: interrupted · task 01a08231-9ca5-71e3-…: cancelled
unresolved:
  - the run was interrupted before acceptance; resume creates a new attempt generation for this task
```

No surviving process group: coordinator 60958 gone, worker 61141 gone, and `ps -eo pid,pgid` finds
nothing in either group ([`at07-process-group.txt`](2026-09-08-fourth-gate/logs/at07-process-group.txt)).

`resume` continued the run ([`at07-resume-1.txt`](2026-09-08-fourth-gate/logs/at07-resume-1.txt)):
gen 1 → gen 2 because "the recorded worker process 61141 is gone; session … cannot be rejoined",
`check-1` passed, task accepted, run `ready_for_review`, exit 0. **Prior work preserved:** the gen-1
branch still holds `docs/index.md docs/n01.md docs/n02.md`, the gen-2 branch all eight notes
([`at07-branches.txt`](2026-09-08-fourth-gate/logs/at07-branches.txt)). **No duplicate accepted
writer:** `{"generation":1,"state":"superseded"}, {"generation":2,"state":"completed"}`. A second
`resume` created no attempt at all and preserved both
([`at07-resume-2.txt`](2026-09-08-fourth-gate/logs/at07-resume-2.txt)).

## AT09 — dependency release · PASS

Run `01a0822e-a73e-7608-a229-30000c1866cb`, plan `fast` / `dependent(["fast"])` / `slow` (which must
run `sleep 150` first), `maxActiveTurns` and `maxActiveWriters` both 2. From the run's own event
timestamps ([`at09-timeline.txt`](2026-09-08-fourth-gate/logs/at09-timeline.txt)):

```
+   0.4s  turn.started            slow
+   0.3s  turn.started            fast
+  16.1s  runtime.turn_completed  fast
+  16.7s  turn.started            dependent     <-- released here
+  31.7s  runtime.turn_completed  dependent
+ 174.4s  runtime.turn_completed  slow          <-- still running the whole time
```

The dependent both started and finished inside the slow task's turn, with 142 s to spare, using the
slot `fast` had just released; the cap of two active turns held throughout. Combined candidate
accepted, exit 0. As in the third gate, this fixture demonstrates the **scheduler**; it does not
demonstrate that the dependent consumed its prerequisite's artifact, because the plan text dictates
the token and is quoted back to the dependent in its own prompt.

---

## Defects

| # | Severity | Defect |
| --- | --- | --- |
| 1 | **major** | **`send_message` collides with a runtime built-in of the same name.** `codex-cli` 0.147.0 ships `functions.collaboration.send_message` ("Send a message to an existing agent"), and the coordinator's prompt asks for `send_message` unqualified (`src/core/run-direct.ts:833`). When the model picks the runtime's tool, the peer message never reaches the coordinator: **no message row, no event, nothing in the run output**, and the worker is told `agent with id <peer task id> not found`. Seen in 2 of 6 real runs here (AT05 run 3, and the first finished-recipient attempt). It is why AT05 run 3 failed, and it is the true cause of the "the coordinator says that task id is not registered" claims that the second and third gates recorded as worker confabulation. The failure is safe — nothing is accepted on a fabricated answer — but it is invisible to the operator and it makes AT05 intermittent |
| 2 | major | **The portable handoff packet is still never written.** `<runDir>/handoff/` does not exist after the AT04 run, so the `writeFileSync` in `src/recovery/continue.ts:96-105` throws `ENOENT` into a silent `catch` and `packetPath` becomes `null` with nothing said. The packet is built, validated and transported in memory — which is why AT04 passes. Unchanged from the second and third gates |
| 3 | minor | `read_inbox` still returns the note *"Acknowledge what you have handled and continue working; do not poll this tool in a loop."* while the coordination prompt tells the worker to *"call send_message … then read_inbox for the answer"*. Observed again in AT05 run 3. Unchanged |
| 4 | minor | The planned path still prints `artifacts: <runDir>/artifacts` followed by `result.json · summary.md · candidate.patch · checks/ · logs/`, though on the planned path those files live under `artifacts/tasks/<attemptId>/` and the run manifest `planned-result.json` is never named. Unchanged |

Third-gate defect #1 (a message to a finished recipient accepted, reported as sent and silently
dropped) and the `[object Object]` body are **fixed**; both are demonstrated above. Third-gate
defect #3 (a dependent's briefing names but does not carry its prerequisite's content) was not
re-examined this round and is neither confirmed nor withdrawn here.

## One thing this record does not explain

Partway through, the scratch directory holding the first attempt at this gate — its logs, plans and
fixture repository — was emptied and replaced by a `git archive` extraction of **this** repository at
`ee5581d` plus a `work/shellrepo` directory. Nothing in this gate's runs can produce that: no run
here had this repository as its `--repo`, the verifier's disposable copies are `mkdtemp` directories
under the OS temp root, and this repository's own working tree was clean before and after
(`git status --short` empty, `HEAD` unchanged). Another Claude Code session was running on the same
machine at the time and is the likely author, but that is not proven. Everything in this record was
re-run from scratch in a fresh, uniquely named directory afterwards and was unaffected. It is
recorded because the evidence for the first attempt no longer exists, and a record should say so.
