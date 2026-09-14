# Automatic workforce and compact Headquarters verification

Verified locally on 14 September 2026. Canonical source: `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`. Live app: http://127.0.0.1:4421/.

## Delivered behavior

- Active workers can serve all registered projects by default. An explicit restricted scope remains available. Archived records are excluded. Control Center selects specialists by requested capability and available capacity; each named worker has exclusive ownership while running.
- Read-only codebase explanations use a dedicated analysis execution path. They do not require repository test configuration. Implementation requests retain independent acceptance checks; committed `test` or `check` package scripts are discovered automatically.
- Headquarters shows work across projects, actual task owners, useful latest actions, elapsed time and recorded progress. Available agents use compact two-column rows at wide content widths; active work uses the space needed for its project and task.
- Work in focus and the special Control Center banner are removed. Tom Chandler uses the normal avatar treatment. Handoffs and detailed assignment briefs expand on demand. Raw runtime and reasoning events are excluded from the overview.
- Reviewed analysis is labeled separately from verified code and can complete a linked issue only when its report, manifest and head review pass the shared integrity checks.

## Actual installed Codex execution

The original failed `agents-office` request was resubmitted through the Headquarters composer with Automatic team. The exact request was preserved:

> I want you to look into this called base and understand and tell me how or what are the features of this harness?

Control Center selected Engineering, Mike Slattery submitted a structured one-worker plan, Russ Jeter inspected the source, and Mike independently reviewed the report. The installed runtime was Codex CLI 0.154.0, using the saved GPT-6-Astra / Medium settings.

- Request: `01a09c2b-3994-706b-8497-9b123f734b81`
- Run: `01a09c2b-8837-7478-9f99-51bb1d74c1f2`
- Exit code: 0. Head review: passed. Worker and head sessions stopped.
- Analysis projection: reviewed, source unchanged, one report, no evidence errors.
- Terminal manifest: `analysisReviewed: true`, `accepted: false`. This is a reviewed explanation, not code acceptance.
- No code-verifier commands ran. Original checkout HEAD, complete Git diff and porcelain status matched the captured before-state exactly, preserving its existing two modified files.
- The completed result survived the final backend restart. No requests were active during that restart.

See [machine-readable proof](live-proof.json), [full run receipt](live-run-final.json), and [reviewed report](agents-office-reviewed-report.md). The report analyzes the committed source snapshot and explicitly distinguishes source findings from untested behavior of the inspected application.

## Concurrent project admission

[Concurrency proof](concurrency-proof.md) uses the real HTTP queue with owned, controlled runtime processes. Two different projects overlapped for 464ms, a third request waited and started automatically when capacity became available, a duplicate returned the original receipt, and no worker overlapped with itself. Capability selection and unchanged fixture configurations were checked. These are controlled-runtime scheduler results, separate from the actual Codex execution above.

## Browser verification

The actual served Headquarters was inspected through the browser, not only static markup:

- At 1440 × 1000 with the task sidebar open, all ten available agents fit in the first screen. Rows measured 436 × 64px. Team workload began at y=420.75px.
- The completed analysis operation measured 216.25px tall after compaction, compared with the approximately 388px operation observed before this pass.
- At 390 × 844, document width remained 390px; agent rows were 302 × 64px. The task sidebar also stayed within the viewport, and the full assignment brief was closed by default.
- Clicking Russ's row opened his activity inspector. A discovered event-attribute collision that had opened department settings was fixed and covered by a regression assertion.
- The report opened from the compact latest-result link. It displayed Reviewed analysis, one reviewed report, and code unchanged. Historical missing-assignment failure displayed Did not start; Waiting remained zero.
- Temporary viewport overrides were reset, and Headquarters was left open at the user's normal browser size.

## Automated verification

- Final full suite: **1,880 passed, 34 skipped** across 170 test files (168 passed, two skipped). See `regression-final.log`.
- Frontend suite: **58 passed**, zero failures. See `frontend-final.log`.
- TypeScript checking and build passed; whitespace check passed.
- The final agent-row attribute correction subsequently passed all **47 fleet tests** and was verified in the browser.

The local server was rebuilt and restarted from the canonical source with the same saved state directory; final process identity is recorded in `restart-final.json` and `live-office-final.json`. No commit, push or remote deployment was performed.
