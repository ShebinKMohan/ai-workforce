# AI Workforce desktop harness evidence — 13 September 2026

This pass was exercised in the local desktop app at `http://127.0.0.1:4421/`, against the registered **AI Employee** project on `codex/workspace-dogfood`. The saved workspace remained at revision 17. Live checks created bounded request receipts, not a new project registration or a source apply operation.

## Implemented experience

- Public navigation, titles and workspace copy use **AI Workforce**. The existing CLI command, state paths and protocol identifiers retain `workforce` for compatibility.
- The Codex-style chat keeps the primary answer readable and execution traces expandable. Runtime, model and effort choices come from the installed runtime catalog, with loading, refresh and unavailable states. Per-message selection is frozen separately from runtime defaults; department heads and workers retain their own settings.
- Multiple-file selection, drag/drop, removable chips, upload failures and draft/retry attachment identity are wired through authenticated storage, durable intake, head planning, workers, review and recovery.
- Project selection uses a local folder browser with familiar locations, registered-project shortcuts, breadcrumbs, filtering and Git inspection. Manual path entry remains an optional advanced route.
- The office has stronger directional lighting, contact shadows and platform depth. A phase legend and directional packets represent recorded intake, routing, assignment, checks, review and reply events. Old history and idle agents do not generate fake work. Motion can be paused and respects reduced motion and hidden tabs.
- An opt-in notification control handles completion and requests needing attention. It seeds history silently and deduplicates reconnects. Clicking a notification targets its recorded task.

## Actual multimodal runtime proof

The live browser's native file chooser accepted two files in one selection: `attachment-brief.txt` (149 bytes) and the user's annotated office PNG (222,946 bytes). The brief contains the codename **Polaris**, but does not contain the image's answer.

Using **Codex / GPT-5.5 / low**, the user-facing prompt asked for the codename from the text and the exact red annotation from the image. Control Center returned:

> The release codename is Polaris.
> The red annotation text says: What is this shape

Request `01a09998-7249-766b-b31a-550b1e800f40` recorded both attachment IDs and the effective model/effort. Its owned runtime session `01a09998-7540-77b3-8cbf-cae3904c0fc5` stopped successfully. It answered directly, with no worker run. Intake including startup, inference and settlement measured **10.76 seconds**. Reloading the chat preserved both filenames and the answer. See [the recorded receipt](multimodal-receipt.json).

A second workspace-only request identified **AI Employee** as the selected project. During its owned intake, the office displayed “Control Center is routing” and one active task; after the response it returned to zero active tasks. Its recorded elapsed time was **9.64 seconds**, so these checks do not establish instant AI routing. See [the intake receipt](scene-intake-receipt.json).

Installed versions: **Codex 0.147.0**, **Claude Code 2.1.236**. The installed Codex catalog reported Sol, Terra, Luna, GPT-5.5 and Spark; it did not report Astra. Browser interactions verified that changing from GPT-5.5 to Sol changes effort choices, and that selecting a different effort works. The composer was restored to GPT-5.5 / low. Separate model evidence is in [runtime-models-2026-09-13](../runtime-models-2026-09-13/README.md).

## Folder browser and desktop checks

Projects → Add a project → Browse folders opened the local picker. Selecting the AI Employee shortcut and “Use this folder” ran the existing Git inspection and displayed **“This repository is already in the workspace.”** Registration stayed disabled, and the dialog was cancelled without modifying the workspace. The browser tested the actual repository, including its dirty working-tree status.

The scene pause button changed to “Resume scene motion” and then returned to its normal state. Keyboard resizing changed the right panel from 430 to 446 pixels and restored it to 430, keeping the workspace stationary. The current in-app browser reports notification permission as **denied**, so the control honestly displays that it is blocked; no permission setting was changed and no operating-system delivery is claimed.

Screenshots in this folder:

- [Folder browser](project-folder-browser.png)
- [Existing-project inspection](project-inspection.png)
- [Owned Control Center intake, captured before the final scroll repair](live-control-intake.png)
- [Final desktop overview, visible viewport](desktop-overview.png)

## Supported file delivery and limits

| Content | Codex adapter | Claude Code adapter |
| --- | --- | --- |
| PNG, JPEG, GIF, WebP | Native image turn input | Native image content blocks |
| PDF | Staged file reference for runtime tools | Native document content block |
| Text and source files | Bounded UTF-8 excerpt at intake plus staged file reference | Bounded UTF-8 excerpt at intake plus staged file reference |
| Other binary formats | Explicit file reference; no promise of native interpretation | Explicit file reference; no promise of native interpretation |

Limits are **8 files**, **5 MiB per supported native image**, **10 MiB per other file**, and **25 MiB total per message**. Staged bytes are size/hash checked again before use. Known model metadata that excludes image input prevents a native image turn. File contents remain user-supplied document data, not authority to override the request.

## Validation and boundaries

The final full automated suite passed **1,626 tests**, with **32 skipped**, across **147 passing / 2 skipped files**. The production build, TypeScript check and `git diff --check` passed. The final run completed in 53.71 seconds; see [the test output](test-results.txt).

Final review also fixed two folder boundary cases: a protected state descendant named `..private` cannot be reached directly or through a visible symlink, and adjacent repositories `repo` and `repo ` remain distinct through listing, navigation, inspection and registration. The latter test verifies distinct Git HEADs as well as exact paths.

The desktop walkthrough found and repaired a shell-scroll defect caused by focus navigation and absolute accessibility labels. With the fix loaded, focusing the composer, opening the activity legend's exact request, expanding/collapsing its trace and jumping to the latest answer kept the workspace's `scrollTop` at zero and the sidebar header at its expected 60-pixel top position. Only the transcript scrolls. The server was rebuilt and restarted while no requests or project runs were active.

The real runtime proof here is Codex direct intake with native vision and text. Automated adapter, planning, worker, review and recovery tests cover attachment propagation and integrity; this pass did not perform a live Claude task or a new attachment-bearing worker implementation. The installed Claude execution boundary remains explicitly gated in the UI.

Notifications require a running page and browser support/permission. Each ordinary chat send still creates an independent request; a prior answer is not automatically included as conversational context. Explicit task follow-ups, portable skills/tool management and checkpoint delivery are remaining product gaps, described with primary sources in [the harness research](../../harness-research-2026-09-13.md).
