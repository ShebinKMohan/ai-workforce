# Frontend consolidation and Issues integration — 13 September 2026

The active source is `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`.
Frontend source is now under `web/headquarters`; the TypeScript backend remains in `src`.
The backend serves the current Headquarters entry at both `/` and `/index.html` on port 4421.
The original workspace and older office remain available at `/workspace/` and `/office/`.

## Preserved source and removal

- `copy-manifest.json` records 342 copied frontend source/artifact files and their SHA-256 digests.
  Every digest matched immediately after copying and again before removing the original folder.
- `original-chatgpt-project.tar.gz` preserves the complete original frontend project, including Git
  metadata. SHA-256: `0c96541399a317657de95da181296b625414ec21802727251476b0f560311d83`.
  This recovery archive stays on the original Mac and is excluded from GitHub; the consolidated
  frontend source is versioned under `web/headquarters`.
- `removal-receipt.json` records that `/Users/shebin_mohan_k/Documents/ChatGPT` was removed from
  Documents after verification. It is recoverable at
  `/Users/shebin_mohan_k/.Trash/ChatGPT-consolidated-2026-09-13`.
- The existing workspace/team state stayed byte-identical at revision 4 during the migration.
  It remains outside the source tree at
  `/Users/shebin_mohan_k/Documents/Workforce-Dynamic-Office-2026-09-12/empty-state`.
- Preexisting dirty backend work was preserved. No reset, cleanup, commit, push or remote deployment
  was part of this consolidation.

## Issues and execution

The new project Issues page persists full issue/plan/PRD text and exposes Backlog, To Do,
In Progress, In Review and Done. An explicit send uses the existing Control Center request queue.
The SQLite issue store retains revisions and idempotent submission receipts. Manual status is
separate from runtime verification; verified completion requires accepted worker checks and
head review of the exact combined candidate.

`browser-crud-receipt.json` records browser creation, editing, movement and reload persistence
on the disposable proof workspace. The full multiline brief, including literal markup, survived.
A manually completed card had no linked request and did not execute a new task.

The [MCP execution proof](../issues-mcp-2026-09-13/README.md) records a real external plan submission,
Control Center classification, head planning, one Codex worker, independent verification and
head review. The original fixture repository was unchanged. Its temporary HTTP server was
closed after browser checks; the proof state and artifacts remain available.

## Validation

Before the one-click follow-up, backend regression passed 1,722 tests with 32 skipped; focused
integration passed 107 tests and frontend behavior passed 47 tests. Their final logs are kept
in this directory. Earlier non-final logs record intermediate failures that were corrected.

The [one-click setup evidence](../one-click-setup-2026-09-13/README.md) supersedes those counts
for the final combined source and documents the installed native app, actual Codex/Claude
connection setup, and current runtime identity.
