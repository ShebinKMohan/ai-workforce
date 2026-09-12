# Local developer harness UI verification — 12 September 2026

This record covers the first UI/runtime pass before the user's subsequent automatic Control Center hierarchy amendment. The existing isometric workforce was retained and the actual AI Employee source repository was registered for a browser-submitted coding task. The initial run in this record used an explicit Engineering destination; it is not evidence of automatic routing or department-head review.

## Implemented and observed in this pass

- Shared desktop styling, typography, controls, calmer department/status colors, a symmetric central platform and usable scene focus/fit/zoom.
- A resizable right task conversation with recorded progress, formatted runtime output, a fixed composer, preserved drafts, scroll restoration and Jump to latest.
- Agent directory with active/archived views, atomic head replacement, project assignments and persisted configuration. A temporary UI verification agent was created and archived; the user's original seven active agents remained intact.
- Project registration for `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`, with the four Engineering workers assigned.
- Exact executable/version/sign-in reports, workspace-specific runtime/model/effort settings, explicit consent status, and durable request submission deduplication.
- Actual unsupported-model failure surfaced during live validation; the workspace Codex binding was set to `gpt-5.5` / `medium`, preserving global CLI configuration.

## Proof

| Layer | Result |
| --- | --- |
| Full checkout regression suite | 111 files passed, 2 skipped; 1,237 tests passed, 32 skipped, 0 failed. See [tests.log](tests.log). |
| Final UI regression after formatting/presentation refinements | 15 files, 139 tests passed. See [final-ui-tests.log](final-ui-tests.log). This overlaps the main suite and is not additive. |
| TypeScript and build | Passed; the rebuilt backend was restarted on the existing user's port 4421 after checking for active work. |
| Desktop interaction | Pointer resize 430 → 506 px; keyboard resize; reload persistence; fit/focus; runtime inspection; project/model configuration; create/archive agent; actual task submission and evidence navigation. No horizontal overflow at 1440 × 950. |
| Real runtime task | One Engineering head, one assigned worker (Shebin), one scoped source change, 3/3 worker checks and 3/3 combined checks passed. See [runtime.md](runtime.md). |

Desktop previews: [workspace and recorded verification](workspace-desktop.png), [task chat](workspace-chat.png), [runtime details](runtime-management.png).

## Runtime identity and preservation

The live workspace is `http://127.0.0.1:4421/`, backed by `/Users/shebin_mohan_k/Documents/Workforce-Dynamic-Office-2026-09-12/empty-state`. The successful request is `01a09676-1277-71fd-ba62-445046df8777`, run `01a09676-17ac-77f7-90fc-d1bc26e4e614`. The [runtime evidence](runtime.md) names the committed base, exact runtime settings, hash-verified patch, check receipts and retained candidate revisions.

The candidate was not applied to the user's active checkout. Existing `.chainlit/` and `.claude/` folders were preserved. Other local workspace servers were left untouched. No deployment, publication or desktop installer was produced.

## Limits and later authority

The coding proof exercises three dependency-free checks for one function; it does not run the whole checkout suite inside the isolated runtime candidate, install dependencies there, or prove a Claude head run. It is local execution evidence, not a complete production-release declaration.

The user's later instruction replaces manual team selection with automatic Control Center routing and department-head review before the final response. That implementation and its proof must be recorded separately. The user also clarified that this product is desktop-only: all further visual validation should target PC use, not mobile.
