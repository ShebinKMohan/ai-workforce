# Control Center live acceptance — 12 September 2026

A real plain-language message submitted through the local UI completed the full Control Center → Engineering head → one worker → independent verification → head semantic review → Control Center final-reply path. The request ended with exit `0`, the run is `ready_for_review`, and the mandatory head review passed after its structured review tool completed and its runtime process stopped.

This task produced an isolated candidate for one function. It did not apply, merge, push, or deploy that candidate.

## Intake and execution identity

| Evidence | Recorded value |
| --- | --- |
| Local UI/API | `http://127.0.0.1:4421` |
| Project | `ai-employee` — `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee` |
| Request | `01a0969f-238b-7596-86e1-37927628c836` |
| Run | `01a0969f-4883-757d-a746-fefdbea9c082` |
| Submitted department | `null`; no department selector or `@department` directive was used |
| Routing method | `classifier`; no project routing rules were configured |
| Selected department / head | `engineering` / `engineering-head` |
| Routing runtime / reported settings | `codex-local` / `gpt-5.5`, `low` |
| Routing session | `01a0969f-27f7-7201-9069-299a8ad83222`, recorded `stopped` |
| Workspace revision at routing/admission | `13` |
| Reserved and assigned worker | `shebin`, exactly one worker and one task |
| Task / attempt | `01a0969f-a1b5-7406-a8fc-bc6bb09c6e3a` / `01a0969f-a1b9-7632-816e-28703cae8845` |
| Worker reported settings | `gpt-5.5`, `medium`; source `runtime_reported` |
| Committed base | `3144b19d1580446c27985110148778fc65acf035` |
| Worker candidate | `04645842426b6930417a69ecbf96e2a6db24ef48` |
| Combined, reviewed candidate | `9871b6b6f24c27e7c04be742ee607c67bc93eac2` |
| Final outcome | Request `ended`, exit `0`; run `accepted` / `ready_for_review`; head review `passed` |

The saved request contains `submittedDepartmentId: null` and `route.method: classifier`. The classifier selected Engineering because this was a scoped implementation and validation request. The head then called `workforce_propose_plan`, and its validated one-task proposal assigned only `shebin`. The roster snapshot, request worker list, task row, and plan agree on that assignment. No repair was needed.

## Measured timing

| Measurement | Observed value |
| --- | --- |
| Request received | `2026-09-12T17:16:46.859Z` |
| CLI execution started | `2026-09-12T17:16:55.939Z` |
| Request ended | `2026-09-12T17:20:14.777Z` |
| Routing, including owned-session stop | `8953.611917 ms` — about `8.9536 s` |
| Per-request worker selection/admission | `0.281416 ms` |
| Receive → final process exit | `207.918 s` |
| CLI launch → final process exit | `198.838 s` |

These measurements describe one observed run. The admission timing covers the synchronous per-request selection and admission calculation; it excludes earlier workspace/readiness reads, routing, and process spawning. It is not the elapsed time from pressing Send to execution.

## Independent checks and the reviewed patch

The candidate changes only `web/claude-office/src/scene-layout.js`, adding this guard before the existing slot-generation logic:

```js
if (!Number.isInteger(count) || count < 0) throw new RangeError('campusSlots count must be a finite nonnegative integer.');
```

The coordinator executed all three configured dependency-free checks against the worker candidate and executed them again against the combined candidate. The combined acceptance record explicitly ignores the worker receipts as substitutes for combined verification.

| Check | Required behavior | Worker receipt | Combined receipt |
| --- | --- | --- | --- |
| `check-1` | `-1`, `1.5`, `NaN`, both infinities, a string, `null`, and `undefined` throw `RangeError`; zero remains `[]` | `01a096a1-2291-7318-9862-128c5b485e42` | `01a096a1-28e9-7380-ae7c-b937ba24bc3c` |
| `check-2` | Exact first-six slot ordering remains unchanged; one slot remains supported | `01a096a1-242e-74e0-913d-b842fb489535` | `01a096a1-2a49-70d5-bfd0-1ea9745da4a0` |
| `check-3` | Count 30 produces exactly 30 unique slots | `01a096a1-25ac-7456-95df-ff239a8d48f6` | `01a096a1-2b9a-77e8-bddd-a1d476395390` |

All six checks passed with exit `0`. The complete command arguments, receipts, evidence provenance, candidate revisions, and acceptance decisions are preserved in [runtime-evidence.json](runtime-evidence.json).

The [verified candidate patch](verified-runtime-candidate.patch) is the full base-to-combined diff supplied to the head reviewer. It was fetched through the server's hash-verifying artifact endpoint and independently hashed during collection:

- Combined diff artifact: `01a096a1-4cd3-70f3-a451-2d95316e41cc`
- Combined diff SHA-256: `a6e1f035979b6a38a1625f9b9ea0aff67efc5e65f4191caf145b39d93e96c5fa`
- Worker patch artifact: `01a096a1-2774-731e-807b-6c485bb121f5`
- Worker patch SHA-256: `484b8adca04ec7c923621faa1bfbf3a3a12f548c073c22b490893f6ca643f3a9`

The review input and final review outcome both bind the combined revision and the combined diff hash. The different worker and combined patch hashes represent their separately produced patch artifacts; both are saved with their own identity.

## Head review and final reply

The Engineering head opened an analysis session on the combined candidate, inspected the actual file and revision, considered the supplied verifier receipts, and submitted its verdict through `workforce_review_result`. A prose statement alone was not used as the gate.

| Event sequence | Recorded event |
| --- | --- |
| `44` → `49` | `workforce_propose_plan` started and completed successfully |
| `57` | Head planning session stopped: `process_tree_terminated` |
| `58` → `60` | One-task plan validated, assigned to `shebin`, planning finished after one attempt |
| `180` → `182` | Worker accepted; task settled with zero repairs; combined checks accepted the combined revision |
| `183` → `187` | Mandatory head review started, review workspace/session opened, review turn started |
| `261` → `266` | `workforce_review_result` started; structured `approve` submission saved; tool completed |
| `274` | Review session stopped: `process_tree_terminated` |
| `275` | `head.review_finished`: `passed`, `sessionStopped: true` |
| `276` | `control.final_reply`: `verificationStatus: verified`, source `department_head_review` |

The review ID is `01a096a1-4cab-724c-aa86-38ceb5d17703`. Its submitted verdict artifact is `01a096a2-3b46-71ba-85f8-d58aefa2070b`; the final review result artifact is `01a096a2-4fae-7410-9dbc-3c98e3f70f7a`. The worker also recorded its owned session as `process_tree_terminated`.

The Control Center's final message reports approval of the scoped guard, preserved valid-input behavior, and the passed verification evidence. Its full text is saved in the normalized evidence and agrees with the final head-review artifact and CLI result.

## Scope of this proof

This verifies one real local Codex classification → planning → worker → verifier → semantic review → final-reply cycle in the actual workspace. It does not establish live Claude execution, every routing intent, every concurrency scenario, or general production readiness.

The three checks cover one function and require no installed npm dependencies. This candidate did not install dependencies or run the full application test suite. It starts from committed base `3144b19`; the worker record confirms current dirty UI/backend changes were excluded. The source checkout still pointed to that base commit when evidence was collected. The main checkout's broader automated checks and browser UI checks are separate evidence.

Collection used read-only APIs and existing manifests/receipts. It created only these evidence files, excluded session authorization material and raw runtime transcripts, and did not apply the candidate.
