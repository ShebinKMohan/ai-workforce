# One-click local access and coding-agent connections

Implemented and checked locally on 13 September 2026.

## Installed access

`/Users/shebin_mohan_k/Applications/AI Workforce.app` is a compiled AppKit launcher, registered
as `local.ai-workforce.launcher`. Opening it starts the workspace if needed, waits for the correct
source and data identity, and opens the page in the default browser. It reuses an existing
matching server. It does not stop unrelated listeners or active work.

The launcher was opened through the macOS UI after stopping the verified idle server. Its
progress window appeared; it built and started the server, then opened **Headquarters · Workforce**
in Chrome at `http://127.0.0.1:4421/`. No Terminal window or pasted command was used.
`launcher-start-receipt.json` records the final helper startup. An earlier native cold launch
started PID 17993 at `2026-09-13T18:12:20.242Z`; the final server uses PID 23694 after loading
the observed Claude diagnostic compatibility fix.

This is a launcher for the local editable source, not a standalone distribution bundling the
entire runtime. It discovers the installed Node executable, restores missing project dependencies
from the lock file, and builds on cold start. A moved source folder can be selected graphically.
Source and startup settings remain in `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`.

## Actual connection setup

The **Connections** page automatically found this Mac's Codex and Claude Code installations.
Each **Connect** button was clicked through the browser UI. Both finished with **Connection ready**,
**Setup saved** and **Tools verified**.

The setup uses each installed client's documented user-scope MCP configuration command with
literal arguments. It reads the named entry back, initializes the exact bridge, verifies all
seven advertised tools and successfully calls the read-only project listing against the running
workspace. A configured entry is automatically checked again after a server restart.

`installed-connections.json` contains only sanitized connection metadata, verification times,
runtime identity and workspace counts. No provider credentials are included. The workspace
remained at revision 4, with zero projects and zero requests. Setup itself started no model turn.
Existing coding-agent conversations need to reopen/reload to consume the new registration;
the application does not claim that an already-open conversation has loaded it.

The live Claude installation exposed a second documented-tool output shape: when other plugins
exist, the missing-entry message lists their names. Detection was corrected to recognize that
narrow shape, with a regression test. Unrelated or customized entries are still refused rather
than overwritten. A failed verification retains the saved configuration and provides a retry.

The browser also confirmed that **Open Issues** leads to the five-column board and its
**Add project** action. The primary connection page contains buttons and a natural-language
handoff example; technical metadata is collapsed under Advanced.

## Validation

- Full backend regression: **1,771 passed, 34 skipped, zero failures** across 162 files
  (160 passed, 2 skipped). See `backend-regression-final.log`.
- Frontend behavior: **57 passed, zero failures**. See `frontend-tests.log`.
- Launcher behavior: **3 passed**, covering settings, exact source/state reuse, unrelated-port
  refusal, and two simultaneous cold starts producing one build and one server. See `launcher-tests.log`.
- Installed CLI tests and connection API tests: **19 passed**, including disposable isolated
  Codex and Claude configuration round trips, command bounds, literal arguments, process-tree
  cleanup, authentication gates, duplicate setup clicks, timeout reconciliation and failed
  workspace verification. These tests did not write the real user configuration.
- TypeScript check, build and `git diff --check` passed.

The earlier `backend-regression.log` includes a transient test/source mismatch while the live
Claude parsing regression was being added. The final log is the complete subsequent pass.

The separate [real Codex execution proof](../issues-mcp-2026-09-13/README.md) demonstrates the
MCP-to-Control-Center-to-worker workflow through independent checks and head review. The current
connection checks establish setup and reachability for both clients; they do not claim a paid
Claude execution or automatic delivery into an already-open coding-agent conversation.
