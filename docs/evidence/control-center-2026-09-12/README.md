# Control Center hierarchy — desktop and live runtime proof

Observed locally on 12 September 2026 against `http://127.0.0.1:4421/`. This extends the [earlier UI pass](../harness-ui-2026-09-12/README.md) with automatic routing, exact worker reservation, real department-head review, and a recorded Control Center answer. The actual project is `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`.

## Implemented flow

Every composer message enters Control Center with project context and a submission ID. The composer has no department selector. Control Center records its route, the coordinator reserves available workers, the department head plans within that exact roster, workers execute in isolated candidates, the independent verifier checks the candidate, and the head reviews the exact combined diff before Control Center returns the approved response.

The right panel has separate Chat, Activity, and Runtimes views, a fixed composer, preserved conversation/drafts, pointer and keyboard resizing, and a double-click reset to 430 px. Agent management supports archive/restore, runtime and project assignments, and replacing a department head. A symmetric Control Center platform, consistent labels and state colors, restrained transitions, active-agent effects, and reduced-motion behavior retain the existing office metaphor.

## Real request

- Request: `01a0969f-238b-7596-86e1-37927628c836`.
- Run: `01a0969f-4883-757d-a746-fefdbea9c082`.
- Submitted department: **none**. Route method: **classifier**; selected **Engineering**.
- Routing runtime: local Codex 0.147.0, `gpt-5.5`, `low` effort.
- Recorded routing duration: **8,953.61 ms**, including owned session cleanup. This is one observed cold route, not a latency guarantee.
- Recorded local admission duration: **0.2814 ms**, excluding classification and subsequent process startup.
- Exactly **one worker**, **Shebin**, was reserved and assigned one task by Engineering head.
- Worker and combined candidates each passed the **three configured, dependency-free acceptance checks**.
- The actual head called `workforce_review_result`, approved the exact combined candidate, and stopped with `process_tree_terminated` before `control.final_reply` was emitted.
- Combined candidate: `9871b6b6f24c27e7c04be742ee607c67bc93eac2`.
- Reviewed diff SHA-256: `a6e1f035979b6a38a1625f9b9ea0aff67efc5e65f4191caf145b39d93e96c5fa`.
- Final state: **ready_for_review**. The test candidate remains unapplied.

The task hardens `campusSlots(count)` in one source file. Checks reject invalid counts, preserve the exact first-six layout and empty zero result, and prove thirty unique slots. See [runtime evidence](runtime.md), [normalized records](runtime-evidence.json), and the [verified candidate patch](verified-runtime-candidate.patch).

A separate browser greeting (`01a0969c-a86b-7772-985e-5f69ec2fa37b`) returned in **20 ms from persisted receipt to terminal response** with no run or worker. The UI displays it once as an ordinary answered message and excludes it from execution activity and review counts.

## Verification

| Layer | Observed result |
| --- | --- |
| Full checkout regression | 123 files passed, 2 skipped; **1,388 tests passed, 32 skipped, 0 failed**. [Log](tests.log). |
| Final desktop/UI regression | **173 tests across 20 files passed** after the direct-answer, identity/status, evidence-page and HTTP module fixes. [Log](final-ui-tests.log). This overlaps the main suite. |
| Build/typecheck/diff | Passed. The local backend was rebuilt and restarted on the existing port only after verifying it had no active work. |
| Browser submission | Actual UI send with project `ai-employee`; no selected department or route directive. A durable receipt, automatic route, reserved worker, live execution, head review and final reply were visible. |
| Desktop layout | 1440 × 950; no horizontal document overflow; 430 px reset width; project context and empty composer preserved after navigation/reload. No further mobile testing. |
| Live result | Real Codex planning, worker tools, verifier checks, head review tool, stopped-process receipt, and final reply. |

Desktop captures: [worker executing](workspace-running.png), [head reviewing](workspace-head-review.png), [final Control Center answer](workspace-final-reply.png), [task evidence and developer review](task-evidence.png).

## Project defaults after the acceptance task

The task-specific campusSlots checks were replaced through the project settings UI. Workspace revision **17** retains the same repository and four Engineering workers and now contains one general check command. [Saved configuration](project-defaults.json).

That command uses `spawnSync` with `shell: false` to execute `npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund`, `npm run build`, `npm run typecheck`, and `npm test` in sequence. Combining the stages matters: the verifier creates a separate frozen copy for each criterion, so separate installation and test criteria cannot share dependencies. Dependencies are installed inside that disposable copy; the user's checkout is not used as a dependency cache.

The normal check is being validated through the actual verifier against the committed implementation. Its first execution exposed a macOS Unix socket path-length defect under the verifier's nested temporary directory and seven fake-Claude fixtures that depended on the host login; installation, build and typecheck passed, but the test suite failed. The source and coordinator-state integrity guards remained clean. The [failed proof](project-default-validation-initial.json) is retained separately from the successful live model task above. The bridge now chooses a private socket endpoint within the byte limit, and the fake-Claude fixtures use deterministic readiness while production authentication checks remain intact. Historical tasks retain their original saved check configuration.

## Practical limits

- General language classification uses a model turn; the observed 8.95 seconds is not instant routing. Explicit saved project rules and simple greetings use a local fast path. Capacity selection is code and does not require a model round trip.
- One project still has one active coordinator run. Other projects may run concurrently within configured limits; a new request waits visibly without cancelling older work.
- A request targets one department. Ambiguous cross-domain requests produce a clarification rather than arbitrary fan-out.
- A negative head review preserves the candidate and feedback. Automatic semantic rework is not implemented; existing verifier repair is a separate mechanism.
- The live proof uses three focused checks against committed base `3144b19d1580446c27985110148778fc65acf035`. It does not install dependencies or run the full checkout suite inside that isolated candidate. The candidate excludes the overhaul that was uncommitted when it was submitted.
- Codex was live-proven. Claude Code is discoverable and configurable, but this record does not prove the new Claude planning/review hierarchy. Other CLI families require supported adapters.
- Usage is derived from identifiable runtime counters. Partial coverage and unavailable currency cost are labelled; a separately recorded routing session is outside the run token footer. No invented elapsed-time completion percentage is displayed.

This is local desktop/runtime evidence, not a deployed release or a blanket production-readiness assertion. No candidate was applied, merged, pushed or deployed. Existing `.chainlit/` and `.claude/` folders and unrelated local workspace servers were preserved.
