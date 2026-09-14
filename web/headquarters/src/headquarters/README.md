# Workforce Headquarters

Headquarters is now a connected browser interface for the installed-runtime AI Workforce harness. It uses real workspace configuration, model catalogs, requests, files, run evidence and results from the production coordinator. The former browser-local demonstration responses are no longer the active entry point.

## Open and run

From `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`, run `npm start` and open
`http://127.0.0.1:4421/`. Headquarters now lives in `web/headquarters` beside the backend.
The same server serves all frontend assets and coordinator APIs. There is no separate bridge
process in the active startup workflow. The original bridge files remain preserved as migration
history and their tests continue to exercise that original implementation.

The source entry point is `src/headquarters/index.html`; the backend maps the root URL to this same entry and its absolute asset
paths. Runtime configuration, requests and evidence retain their
existing state folder, selected by the root startup preferences. The following dated evidence
refers to the pre-consolidation deployment unless explicitly identified otherwise.

## Control Center

The orchestrator is named **Control Center**. It runs a bounded AI intake turn on the chosen installed runtime. It can answer directly, ask for genuinely missing context, or route actionable work to a department head. Heads plan and review; workers implement; the coordinator independently verifies candidates.

The default right sidebar is a Task status feed: counted All, Backlog, In progress, Waiting, and Done filters, with cards from the real request queue. Cards open their conversation; Back to tasks restores the feed. A compact composer stays at the bottom. Feed submissions create independent tasks; followups inside a card retain their task context. Drafts and uploads entered during submission survive for the next task. Stopped and discarded requests appear in All without inflating Done.

The chat keeps the main response readable. Work details remain collapsed until expanded, with individual recorded events, routing, verification, and actual output artifacts. Available patches and receipts can be opened or downloaded. Stop controls target the recorded request. A new conversation preserves older work.

Runtime, model, effort and project are selected in the composer. Models and supported efforts are fetched from `/api/runtimes/:id/models`; they are not a hard-coded marketing list. Runtime defaults inherit configured bindings. Each installation keeps its own catalog and execution binding. On this Mac, `/opt/homebrew/bin/codex` is the existing global npm installation. It has been updated from 0.147.0 to official stable 0.154.0 and now reports GPT-6 Astra. The unused `codex-desktop` harness binding was removed in workspace revision 20; the desktop application remains installed and historical execution records retain their frozen provenance. Claude model labels preserve the runtime-reported resolved identity: Opus 5, Fable 5.1, Sonnet 5 and Haiku 4.5 in the current catalog, while execution retains its accepted selector aliases. No plan or model allowlist is hardcoded.

**Auto handoff** follows the new-conversation preference in Settings, initially on. Turning it off sends genuine `mode: "discuss"` requests: the server does not dispatch workers in that mode, even if a model incorrectly proposes delegation.

Followups within an opened task reference a recorded `priorRequestId`; new feed submissions omit it. The server validates project ownership, freezes bounded context (up to eight prior exchanges / 16,000 characters), and inherits verified upload identities. The history is reference material, not authority to override the latest request. New messages do not cancel earlier running requests. Explicit steering of a running worker is a separate capability.

## Files and projects

The attachment button accepts multiple real files. Drag/drop and pasted images use the same upload flow. Chips distinguish upload progress, readiness and failure. The server stages and hashes actual bytes; filenames alone are never treated as uploaded content.

Existing adapter delivery modes:

| Content | Codex | Claude Code |
| --- | --- | --- |
| PNG, JPEG, GIF, WebP | Native image input | Native image blocks |
| PDF | Staged file reference for runtime tools | Native document block |
| Text/source | Bounded text excerpt plus staged reference | Bounded text excerpt plus staged reference |
| Other formats | Staged reference, subject to runtime tools | Staged reference, subject to runtime tools |

Native audio/video or arbitrary binary understanding is not promised. Known model modality restrictions are checked before submission, including inherited files.

The coordinator's upload limits are eight files, 5 MiB per native image, 10 MiB per other file, and 25 MiB total. File hashes and sizes are checked again before execution. Uploaded document contents remain untrusted task data.

Projects uses a real local filesystem browser: familiar places, mounted volumes, folder filtering, breadcrumbs, parent navigation, and Git inspection. Selecting a project does not upload its entire directory. This developer harness currently requires a Git repository with a committed base. Optional advanced **verification commands** are executable checks, not prose requirements. Archive does not delete the repository.

## Organization

Agents and Departments edit the production workspace with revision-checked, atomic operations. The old sample organization is not imported or overwritten into it.

- Employee name, instructions, capabilities, execution policy, runtime, discovered model/effort, and actual project assignments.
- Department identity and leadership. Replacing a head archives the former identity and creates its replacement atomically, preserving history.
- Control Center runtime/model/effort, instructions, project routing preferences, and all eight shared execution limits.
- Archived records remain inspectable. The backend has no restore operation, so no local-only restore action is presented as real.

Conflicts and failed saves retain form drafts. Concurrent reads cannot replace a newer saved revision with an older response.

## Workspace and autonomy

The enterprise layout renders the actual configured company in crisp light or VS Code/Cursor-style dark mode. Department cards show configured agents, Doing, Next, Done, and real waiting counts. Durable task rows establish worker status; accepted tasks establish Done. Unplanned briefs count only until their run has task rows. Conversations and completed attempts do not inflate department completions. Counters open the underlying requests, including the exact selected worker-task evidence. Totals are explicitly scoped to loaded run history. Recent requests is removed from the canvas. Raised platforms, isometric desks and flat readable nameplates give the office depth without distorting the controls. Workspace/List views and a mobile layout expose the same ownership.

Finite directional packets show message receipt, routing and worker handoff only from recorded events. No timers invent task activity. Historical events are not replayed as current work. Communication motion is always enabled in the workspace and respects system reduced-motion preferences. The dedicated Executions page contains active work and its event timeline. Subtle blinking and hover expressions animate the illustrated 2D human avatars; avatar movement is presentation, not evidence of task execution. Photorealistic portraits are not used.

The production harness now repairs structured department-head review findings internally. Repairs preserve the original accepted task and its artifact, use a same-owner successor within the original scope, and share the durable repair budget with failed-check repairs. Each replacement passes fresh independent checks, combined checks and a new structured head review. Stop/Resume retains the patch, owner and remaining budget. Exhaustion or unavailable capability becomes a concrete blocker.

Runtime access remains meaningful. On this machine, Codex execution was verified. Claude Code 2.1.236 is detected and supplies its model catalog, but its unverified file boundary requires explicit per-request access consent before execution. Ordinary department review does not require human approval.

The desktop Codex build has separate, exact-version macOS conformance evidence for file and network boundaries, streaming, steering, retained-history resume, interruption, and internal coordination. The coordinator provisions only the tools allowed for each session's role, with explicit per-tool authorization. Real coordination checks on both installed Codex versions persisted the expected message, completed the corresponding tool call, and returned the same message ID without an interactive approval. The global approval policy and workspace boundaries remain enforced. Evidence, including the original compatibility failure, is in the runtime repository's `docs/evidence/runtime-installations-2026-09-13/README.md`.

## Preferences and installation management

Settings contains System/Light/Dark theme selection, Comfortable/Compact density, Enter or Command/Control+Enter sending, and the default Auto handoff preference for new conversations. Appearance uses editor and panel charcoal (`#1e1e1e`, `#252526`, `#181818`) with blue actions and focus, brighter neutral text, and distinct state colors. Tested text pairs exceed 4.5:1 contrast. Preferences use `workforce-preferences-v1` in this browser; existing conversation handoff choices remain independent.

Runtimes shows separate installation cards. Discover installations calls `/api/workspace?refresh=1`; other detected executables can be added through the actual `runtime.set` operation. Existing employee and Control Center bindings are preserved when another installation is registered. Models & reasoning effort lists labels, resolved identities, and supported efforts. Model details in chat includes the executable, CLI version, source, and discovery time.

Catalog caches are scoped to the binding and observed executable, realpath, and version. Refresh invalidates stale models, and an earlier in-flight response cannot replace a later runtime selection. Only reports for the exact configured binding determine its status.

Breadcrumbs navigate to Headquarters and parent agent, department, and project pages. The whole app occupies the viewport. Navigation, workspace content, and chat scroll independently. Hidden accessibility announcements have local containing blocks, eliminating the previously reported blank area below Agents and Departments. Configuration uses section cards, archive actions use a box icon, and duplicate team navigation is removed.

## Canvas-first office

Headquarters now gives its main viewport to an interactive office. The previous page-heading/metrics stack and nested department-card layout are replaced by open team areas, individual illustrated workstations, curved handoff connections, and floating workload summaries.

- Drag the background or scroll to pan. Ctrl/Command + scroll zooms around the pointer. The bottom toolbar provides zoom, 100%, and Fit; the department picker focuses a team or Control Center. Touch supports pan and pinch. With the canvas focused, arrows pan, plus/minus zoom, and zero fits.
- Select a teammate or department to inspect it without leaving the office. Actual assigned work opens its task conversation; editing is a separate action. Escape or Close dismisses the inspector and returns focus.
- Doing, Next, Done, and Waiting counters open their precise task scope. Live updates retain the camera, selected teammate, DOM identity, and in-flight handoff animation.
- The task rail defaults to 370px, remains resizable, and keeps a compact composer at the bottom. The new layout migrates old rail widths while preserving messages, drafts, attachments, model/effort, and handoff preferences. Subsequent custom widths persist.
- Narrow screens open a readable team-focused canvas with the same pan/zoom controls. The task rail becomes a drawer. The List option remains available for scanning a large organization.
- Keyboard interaction no longer disables all motion. System reduced-motion preferences still suppress visual animation.

## Current validation

Evidence is in `artifacts/headquarters/`:

- `canvas-office-qa/`: current canvas, inspector, touch, layout and task-rail checks, with real workspace screenshots in both themes.
- `task-feed-qa/`: task-feed/browser checks and a real UI-submitted local Codex 0.154.0 / Astra / low task, observed In progress → Done, opened to the verified response, and returned to the feed.
- `codex-local-consolidation.json`: revision 19 → 20 removes only the unused desktop binding and proves all 14 existing request items unchanged.
- `task-status.test.mjs`: shared truthful request/task status classifications.

- `astra-live-proof.json`: real Codex Desktop / GPT-6 Astra / low Discussion returned `ASTRA-RUNTIME-OK`, ended with exit code 0, and used no unconfined-write consent.
- `modern-validation-summary.json`: final production and frontend check totals, native Astra chat proof, and cross-version coordinator tool verification.
- `INDEPENDENT-UI-QA.md`: 96 layout checks, 56 interaction/detail checks, six runtime-cache regressions, and final 2D-avatar screenshots.
- `runtime-installation-proof.json`: exact installed runtime catalogs and separate desktop Codex registration, with other workspace configuration preserved.
- `live-runtime-proof.json`: real GPT-5.5 / low UI submission with text and PNG. The model read **Lantern-826**, **ORBIT 73**, and a **red triangle** from the actual files. A second message recovered prior context and inherited files. Both discussion sessions ended successfully without worker dispatch; reload retained the response.
- `live-worker-proof.json`: real UI → Control Center → Engineering head → exactly one worker → independent checks → structured head approval. The isolated candidate fixed addition in `math.mjs`; three checks passed. The original fixture source and Git HEAD remained unchanged. Its temporary company state is separate from the user's workspace.
- `live-claude-proof.json`: actual current Claude attempt stopped at `consent_required`. This is evidence of the real boundary, not a completed Claude turn.
- `bridge-integration-qa.json`, `bridge-trace-qa.json`, `bridge-packet-qa.json`: desktop/mobile navigation, drafts, actual filesystem reads, real historical traces/artifact retrieval, and preserved animation duration under polling.
- `bridge.test.mjs`, `runtime-client.test.mjs`: bridge/session/streaming and concurrent state behavior.
- `HARNESS-RESEARCH.md`: primary-source research and a capability comparison against the inspected production source.

Production changes live in `src/server/requests.ts`, `src/routing/control-intake.ts`, `src/core/run-planned.ts` and `src/integration/head-review-repair.ts` in the AI Employee runtime repository. Its own tests exercise conversation isolation, file inheritance/integrity, discussion enforcement, bounded repairs, verification and resume ownership.

## Source and persistence

Active entry point: `index.html` → `live-app.js`.

- `runtime-client.js`: authenticated API client, monotonic workspace state, request/run snapshots and event stream.
- `chat.js`, `live-chat.css`: real Control Center conversation and outputs.
- `organization.js`, `management.js`, `management.css`: live configuration.
- `projects.js`, `projects.css`: project manager and local folder picker.
- `live-overview.js`, `live-overview.css`: interactive company canvas, camera controls, and event-based communication.
- `office-inspector.js`, `office-inspector.css`: contextual agent/department inspection and exact work scopes.
- `workbench.css`: compact navigation and viewport-first application frame.
- `settings.js`, `theme.css`: persistent browser preferences and complete light/dark component themes.
- `ui.js`, `avatars.css`, `live-app.css`, `styles.css`, `polish.css`, `assets/`: shared visual components and bundled font/brand assets.
- `server.mjs`, `server/runtime-bridge.mjs`: loopback proxy with independent browser and upstream sessions.

Conversation drafts and presentation history use `workforce-control-center-conversations-v3`. Previous sample conversations are marked as prior design previews; new real conversations remain distinct. Production requests, attachments, configuration and evidence are stored by the coordinator.

The earlier self-contained HTML in the artifact folder is an archived design prototype. Live execution needs the local coordinator and bridge; it cannot run from a standalone offline HTML file.
