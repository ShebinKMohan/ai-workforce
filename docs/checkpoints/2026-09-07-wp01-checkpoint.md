# Checkpoint — 7 September 2026, after WP01

Paused here at the user's request. Safe to resume from this commit.

## Milestone handoff record

```text
Milestone/package:            WP01 — foundation (Linear SHE-28), plus WP01 review fixes
Implementation branch/rev:    main @ 5d5bad9 (previous: d4f8f3b WP01 foundation, 01af719 baseline)
Feature IDs implemented:      FR011, FR012, FR014, FR015, FR022, FR065, FR066 foundations;
                              FR006 (settings validation contract), FR054 (spawn identity), FR058 (event ingestion)
Runtime versions tested:      none yet (WP01 uses the deterministic fake runtime only);
                              installed: codex-cli 0.147.0, Claude Code 2.1.260, Node 26.8.1
Task fixture / scenario:      fixtures/fake-runtime (scenario-driven fake runtime), fixtures/agents/example.json
Commands/checks executed:     npm run typecheck -> exit 0
                              npm test          -> 10 files, 61 tests passed (re-run at checkpoint)
Candidate/artifact paths:     n/a (no run path yet; run/doctor/resume are stubs, status is real and read-only)
Known limitations:            doctor/run/resume exit 4 not_implemented; fake runtime unsandboxed by design;
                              lock liveness via ps etime (macOS/Linux); schema v1 edited in place before any
                              persisted state existed; no schemas/ JSON export yet; real adapters not started.
Remaining work / next:        WP02 discovery (SHE-29), WP03 Codex adapter (SHE-30), WP04 verified change (SHE-31),
                              integration, R0 demo with real Codex, independent verification.
```

## What happened in the build workflow (run id wf_f8423fc1-ad3)

1. WP01 agent built the foundation and committed d4f8f3b.
2. Two reviewers (durability lens, contract lens) found 3 blocking + 5 major defects.
3. Fix agent addressed all of them and committed 5d5bad9 (tx BEGIN ordering, per-process spawn token in
   event idempotency keys, kernel-arbitrated coordinator lock via SQLite BEGIN IMMEDIATE, generation checks
   on intent/dispatch, event payload bounds, settings validation contract).
4. The three parallel WP02/WP03/WP04 agents were launched with `isolation: 'worktree'` and all three failed
   before producing an agent id (no work was done, no branches or worktrees exist). The integration agent
   then started against empty inputs and was stopped. Nothing from that phase touched the tree.

## How to resume

- Re-launch the workflow from its script with `resumeFromRunId: wf_f8423fc1-ad3`; WP01, both reviews and the
  fix are cached. Change the WP02–WP04 stage first: do not rely on harness worktree isolation. Either run the
  three agents in the main tree with the exclusive-path rules already in their prompts, or have each agent
  create its own `git worktree add` under a scratch directory and report the branch.
- Linear: SHE-28 Done; SHE-29/30/31 Todo; project status In Progress; status updates via the connector.
