# External MCP issue execution proof — 13 September 2026

The real MCP-to-execution path passed on a disposable Git project. An independent stdio MCP client submitted a complete PRD, Control Center classified it into Engineering, the department head proposed one task through its actual coordination tool, one Codex worker fixed the bug, the independent verifier checked the candidate, and the head approved the combined candidate through its actual review tool. The project issue reached **Done / verified candidate**.

This proof used installed **Codex CLI 0.154.0**, **gpt-6-astra**, **low** effort. The exact executable was `/opt/homebrew/bin/codex`; the passive metadata catalog advertised that model and effort and reported the configured writing boundary available. The test granted no unconfined-write consent. Node was v26.8.1 on macOS arm64. The recorded wall time was **130.599 seconds**, including Control Center intake; this single tiny fixture is not a performance benchmark.

## Verified sequence

1. The original `add(a, b)` fixture incorrectly subtracted. All three existing Node tests failed before dispatch.
2. A separately spawned `workforce mcp --server-url <ephemeral-loopback-origin>` process accepted `initialize`, `notifications/initialized`, `tools/list`, and `workforce_list_projects`.
3. `workforce_submit_plan` received the complete multiline PRD with `kind: prd`, `start: true`, a registered project ID, and a stable idempotency key. Repeating the identical submission returned the same issue and request IDs. The successful proof contained exactly one issue and one request before later browser QA.
4. The persisted request had `submittedDepartmentId: null`. Control Center ran its actual model classifier, chose Engineering in 18.119 seconds, and retained the exact `title + "\n\n" + description` envelope.
5. The head completed the real `workforce_propose_plan` MCP call. The accepted plan contained exactly one task assigned to `engineer-one`, with scope limited to `src/math.mjs`, frozen existing checks, and required head review.
6. The worker changed one line: `return a - b` became `return a + b`. It created one accepted attempt with no repair. The original tests, package configuration, and repository instructions remained unchanged.
7. The worker candidate's registered verifier receipt recorded all three tests passing, `verifier_executed` provenance, `git_archive` copy strategy, unchanged complete candidate integrity, and no state-root violations. The separate combined-candidate acceptance record ignored the earlier worker receipt and required a new passing receipt against the exact combined revision.
8. The head completed the real `workforce_review_result` call and approved the exact combined revision and diff hash. Its owned session was confirmed stopped. Control Center persisted the final reply, the run became `ready_for_review`, and the issue became `done` with `execution.verified: true`.
9. A read-only audit checked the stored plan, receipt provenance, uncompromised evidence, combined acceptance, head tool-call events, final reply, exact PRD preservation, and issue/request deduplication. The fixture's original HEAD, Git status and every tracked file hash matched the baseline. Its original checkout still reproduces the deliberately unfixed bug; delivery remains a separate candidate.

## Identities and evidence

| Record | Value |
| --- | --- |
| Project | `mcp-math` |
| Issue | `01a09bdd-ae2b-70ed-b539-6554049260c2` |
| Request | `01a09bdd-b19b-71b3-88df-31f29927ade5` |
| Run | `01a09bdd-fa39-70e1-9024-7e675841e52d` |
| Original revision | `496c1eccddeae6aa1554498ee95c933841eb7c85` |
| Worker candidate | `5fcfa69135e16a6397724ab17598b2ba0f70b968` |
| Combined, reviewed candidate | `3e9c8b505abeba0e2665e198e3fdb779c518aa2f` |
| Reviewed diff SHA-256 | `89944ad5ed644d3d599baa44fc9521a38f30ea64566eda0bba41e22bc97a3254` |
| Fixture/state parent | `/private/tmp/wf-mcp-proof-Bkd0u2` |

- `audit-result.json`: concise verified verdict, identities and exported artifact hashes.
- `proof-result.json`: complete protocol observer result, timings, preserved-source evidence and run projection.
- `submitted-prd.md`, `submit-receipts.json`, `mcp-frames.json`: exact external inputs, idempotency receipts and MCP exchange.
- `runtime-catalog.json`, `workspace-config.json`: exact installed metadata and disposable role/limit setup.
- `plan.json`, `planned-result.json`, `run-final.json`, `run-events.json`: persisted plan, combined acceptance and run evidence.
- `head-mcp-tool-events.json`: actual start/completion records for the planning and review MCP calls, excluding prose and prompt mentions.
- `artifacts/`: registered evidence copied only after its stored SHA-256 was verified, including candidate patches, worker receipt, head input and review result.
- `baseline-check.json`, `fixture-files.json`: the reproducible initial defect and original fixture contents.

The run used a private TypeScript build under ignored `runtime/` to avoid concurrent edits to the application's shared `dist`. `runtime-build-sha256.json` identifies those exact compiled bytes. The build did not change the user's saved team, project configuration, working source, or ports 4421/4328.

## Reproduction

From the AI Employee package root, with the installed Codex account ready and permission for one bounded paid fixture run:

```sh
mkdir -p docs/evidence/issues-mcp-2026-09-13/runtime/docs
cp docs/verified-capabilities.json docs/evidence/issues-mcp-2026-09-13/runtime/docs/verified-capabilities.json
node node_modules/typescript/lib/tsc.js --outDir docs/evidence/issues-mcp-2026-09-13/runtime/dist --declaration false --sourceMap false
node docs/evidence/issues-mcp-2026-09-13/live-proof.mjs
node docs/evidence/issues-mcp-2026-09-13/audit-proof.mjs
```

The script creates fresh temporary fixture/state roots and an ephemeral server port. It spends actual Codex turns, and a rerun replaces the evidence files in this dated directory. Preserve those files elsewhere first when comparing attempts. No mock adapter or canned model reply is used. `serve-qa.mjs` reopens the completed fixture for browser inspection without starting another task; its current URL is recorded in `qa-server.json`.

The first observer attempt is preserved in `attempt-1-observer-url-error/`. Its read-only observer incorrectly combined the server's trailing slash and an API path, received a double-slash HTTP rejection, and stopped before establishing any completed execution. The observer was corrected to use URL resolution. The successful proof above is the subsequent fresh fixture run.

This establishes the external stdio MCP protocol and actual downstream Codex orchestration on a bounded fixture. It does not establish an installed Claude client connection, Claude execution, a large PRD decomposition, remote publication, automatic candidate application, or desktop installer readiness. Browser issue CRUD and linked-task presentation are separately checked by the coordinating agent against the reopened disposable server.
