# Local harness runtime verification — 12 September 2026

The refreshed UI completed a real browser-submitted task on the registered AI Employee project. The Engineering head proposed a plan through its actual coordination tool, one worker produced an isolated candidate, and the three configured checks passed against both the worker candidate and the combined candidate. The preserved checkout was not replaced or applied.

## Initial failure and correction

The live workspace initially had no registered project or worker project assignments. Registration of the user's existing `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee` repository made the Engineering route eligible. The first actual browser submission then exposed a separate runtime failure:

- Request: `01a09670-abaf-712c-94d8-55486143e0fa`
- Run: `01a09670-ad8c-74eb-a74a-378b9de75559`
- Selected executable: `/opt/homebrew/bin/codex`, version `0.147.0`.
- The inherited default selected `gpt-6-astra` and `ultra`; the provider returned HTTP 400 `invalid_request_error`: “The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.”
- The error occurred before any plan tool call. Two head attempts were previously misreported as `plan_rejected`; no worker or check started. The recorded first error remains in that run's `artifacts/head/01a09670-ad9c-76e0-8762-ce85e436547b/runtime-events-1.jsonl`, line 37.

The head planner now preserves that provider message, classifies a hard rejected request as `head_runtime_rejected` with actionable runtime/model/effort guidance, and stops after one head attempt. It still confirms termination of the owned session. An integration regression replays the observed error envelope and proves one session, confirmed stop, and zero worker tasks; all 11 head-planning tests passed.

No global CLI upgrade or global model change was made. A read-only `initialize` → `initialized` → `model/list` probe of the installed `0.147.0` app server reported `gpt-5.5` with `low`, `medium`, `high`, and `xhigh` effort, with `medium` as its default; Astra was absent. The probe started no model turn. The workspace's `codex-local` binding was then saved through Settings with `model: gpt-5.5` and `effort: medium`. The successful worker's recorded result independently reports `effectiveModel: gpt-5.5`, `effectiveEffort: medium`, and `effectiveSettingsSource: runtime_reported`.

## Successful browser submission

| Evidence | Recorded value |
| --- | --- |
| Local UI/API | `http://127.0.0.1:4421` |
| Project / department | `ai-employee` / `engineering` |
| Request | `01a09676-1277-71fd-ba62-445046df8777` |
| Run | `01a09676-17ac-77f7-90fc-d1bc26e4e614` |
| Committed base | `3144b19d1580446c27985110148778fc65acf035` |
| Head / planning attempts | `engineering-head` / `1` |
| Actual plan proposal artifact | `01a09676-892a-752e-922a-a05ee31ee32a` |
| Assigned worker / tasks | `shebin` / `1` |
| Task / attempt | `01a09676-9d93-7235-8df0-d2346dad49d5` / `01a09676-9d96-7560-a8b4-c522d7ebe5cf` |
| Start / end (UTC) | `16:31:55.520` / `16:34:18.299` — about `142.8` seconds |
| Final state | Request `ended`, exit `0`; run `ready_for_review`; task `accepted` |
| Worker candidate | `e5763095afd23d53781ef24cb0732230cac82a2b` |
| Combined candidate | `8fed636a3fb03f1c47657c74cdde617d7d2d27dd` |
| Patch SHA-256 | `16b3a1748e6e4881af0b64465b4c92b45b1d242c4d9e39159d1ef4dbbf779b05` |

The actual `workforce_propose_plan` call returned successfully, followed by `plan.validated`, `head.assigned`, and `task.registered`. Worker file-change events reported one applied change within the permitted source path. The hash-verified patch adds only a three-line `RangeError` guard to `campusSlots(count)` in `web/claude-office/src/scene-layout.js`.

The verifier executed these three assertions with Node, independently of the worker's own claims:

| Check | Behavior | Worker receipt | Combined receipt |
| --- | --- | --- | --- |
| `check-1` | Invalid values throw `RangeError`; zero returns an empty array | `01a09678-19bb-7089-ae6b-dc904d844853` | `01a09678-1ffb-7760-ac66-d0f9944c03a6` |
| `check-2` | First six slots retain their exact order; one slot remains supported | `01a09678-1b51-76d6-be0b-164750cda1aa` | `01a09678-215a-7346-9543-2ac09bf9e6e4` |
| `check-3` | Count 30 produces exactly 30 unique slots | `01a09678-1cc2-75be-8038-77739a4106c2` | `01a09678-22af-7124-8ab5-22bb7d5ef316` |

All receipts passed with exit `0`; worker receipts identify `verifier_executed` provenance. Combined acceptance names the combined revision, satisfies all three criteria, and explicitly excludes the earlier worker receipts as substitutes for combined verification. `integration.combined` records `accepted: true` and no unverified criteria. No repairs or unresolved issues were recorded.

## Saved proof and limits

- [Normalized runtime evidence](runtime-evidence.json) contains selected API records, actual worker settings, event sequence, check receipts, candidate identity, combined acceptance, and source receipt locations. It excludes session credentials and raw runtime transcripts.
- [Verified candidate patch](verified-runtime-candidate.patch) was read through the server's hash-verifying artifact endpoint. The underlying raw logs, manifests, and receipts remain in the original project state root.
- The work started from committed HEAD. Current uncommitted UI/backend changes were excluded from the worker's candidate, and the candidate was not applied, merged, pushed, or deployed.
- This establishes one bounded Codex head → worker → verifier path in the actual UI. It does not establish a Claude head run, automatic cross-department routing, active requirement steering, or a complete production release.
- These three checks are dependency-free behavior checks for one function. Isolated candidates and verifier copies exclude `node_modules`; this run did not install dependencies or execute the full candidate `npm test` suite. The main checkout's full UI/backend regression suite is separate evidence.
- Login, executable discovery, and execution are displayed separately. Exact configured bindings now retain their own diagnostics; a healthy adapter installation cannot make a missing custom executable appear ready. Version-mismatch consent also preserves exclusive queue admission. A retained `clientRequestId` prevents concurrent or reconnected submissions from launching duplicate work.
