# AT03 evidence — the same fixture task accepted through both installed runtimes

Release gate: **R1** · Acceptance test: **AT03** · Work package: **WP05 — second adapter**
Features exercised: FR003, FR004, FR005, FR006, FR011, FR012, FR041, FR042, FR049, FR050, FR058, FR059, FR060

Recorded 7 September 2026, ~22:30 IST, on the author's macOS machine, by the repository maintainer
(not by the building agent). Every number here comes from a file in this directory or from a command
whose output is quoted. Where something was not executed, it says so.

**This record supersedes `2026-09-07-initial/`, which reported the Claude Code half as blocked.**
That record was written while the installed Claude Code CLI held an expired OAuth token, and it also
relied on a credential gate that was itself defective (see "What the earlier record got wrong").
The superseded record is kept intact rather than rewritten.

## Source revision

```
89c8362  Address WP05/AT03 verification findings (FR002, FR003, FR004, FR005, FR042, FR049, FR050, FR059)
```

`npm run build` was run from a clean clone of that commit and both runs invoked `dist/cli/index.js`
from that build. On the same clone, `npm test` is **381 passed / 31 skipped / 0 failed**.

## Environment

| Fact | Value |
| --- | --- |
| Codex | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex`, ChatGPT sign-in live, model pinned `gpt-5.6-sol` |
| Claude Code | `claude 2.1.260` at `~/.local/bin/claude`, claude.ai sign-in live (Max), model `sonnet` → `claude-sonnet-5` |
| Node | v26.8.1 · Git 2.50.1 · darwin arm64 |

Both CLIs' sessions expired at different points during this project and were restored by the user with
`codex login` and `claude auth login`. A coding agent must not perform either flow.

## What was run

One `agents.json` (in this directory) declares both runtimes and one agent bound to each. The task text
is the fixture's bug report, verbatim. Each runtime got its own freshly materialized copy of
`fixtures/ts-bug` and its own state directory. The bug reproduces in both (`node --test test/` exits 1).

```sh
node dist/cli/index.js run --repo <repo-A> --agents agents.json --state-dir <state-A> \
  --agent engineer-codex  --task "<the fixture bug report>"
node dist/cli/index.js run --repo <repo-B> --agents agents.json --state-dir <state-B> \
  --agent engineer-claude --allow-unconfined-writes --task "<the fixture bug report>"
```

### Why the Claude run needs an explicit flag

Without it the run **refuses to start**, and that refusal is the specification working:

> the claude-code adapter reports write_containment "unsupported" for 2.1.260 on darwin … Plan
> section 8 requires an adapter that cannot enforce a required profile to fail that mode rather than
> silently broaden it. Bind this agent to a runtime with a verified write boundary, give it the
> read-only "analysis" profile, or pass --allow-unconfined-writes to accept an unconfined run.

`--allow-unconfined-writes` records a permanent `unresolved` entry in the manifest stating that
acceptance means the configured criteria passed, **not** that the worker's effects were confined.

## Results

| | run A — Codex | run B — Claude Code |
| --- | --- | --- |
| run id | `01a07cd2-69ce-73e4-bfd9-f4dd54917faf` | `01a07cd3-b1b3-76a6-ad23-f5467b0d03a0` |
| base revision | `a2334e4` | `d20660d` |
| exit code | 0 | 0 |
| outcome | accepted | accepted |
| changed files | `M src/pagination.js` | `M src/pagination.js` |
| candidate patch sha256 | `64928335266a1fae…` | `2a4859774b600038…` |
| check | `node-tests-pass` exit 0, 89 ms, `verifier_executed` | exit 0, 82 ms, `verifier_executed` |
| effective model | `gpt-5.6-sol` | `claude-sonnet-5` |
| write boundary | verified, kernel-enforced | **none**; explicitly acknowledged |

### Timing (ms) — two samples on one machine; observations, not a benchmark

| phase | Codex | Claude Code |
| --- | --- | --- |
| dispatch | 274 | 172 |
| runtime startup | 216 | 873 |
| model/runtime turn | 83 139 | 18 147 |
| validation | 215 | 210 |
| **total, submission → accepted** | **83 870** | **19 904** |

### Usage

| | Codex | Claude Code |
| --- | --- | --- |
| tokens in / out | 136 283 / 1 794 | 10 / 1 393 |
| cost | **unavailable** (`costUsd: null`) — the app server reports no price | **measured**, `$0.04694` |

The two runtimes trade off in opposite directions: Codex provides a verified kernel-level write
boundary but no cost figure; Claude Code provides a real cost figure but no write boundary.

The patches are **not** byte-identical this time, though an earlier pair was. Identical output is a
property of a particular pair of runs on a small fixture, never a guarantee.

## What was verified, and how

Checked by the maintainer, outside the coordinator, for **each** run:

1. **Acceptance came only from a verifier-executed check.** Both criteria carry
   `evidenceProvenance: verifier_executed`. Neither runtime's own completion claim decided anything.
2. **The patch really fixes the bug.** A clean `git archive` of the base fails `node --test` (exit 1);
   the candidate patch applies; the same copy then passes (exit 0). Done for both patches.
3. **Only source changed.** `changedFiles` is `M src/pagination.js` in both. Neither run touched the
   acceptance suite.
4. **The user's checkout is untouched.** Both fixture repos: `git status --porcelain` empty, still on
   `main` at the base revision, and `src/pagination.js` still contains `Math.floor` — the bug.
5. **`npm test` is clean on a fresh clone**: 381 passed / 31 skipped / 0 failed.
6. **The acceptance-surface bypass is closed.** A candidate that adds a `.gitattributes` marking the
   acceptance suite `export-ignore` plus one trivially passing test — which modifies no pinned file —
   is now **refused**: the check runner compares its `git archive` copy against the candidate's own
   tree listing, completes it, runs the real suite, and the criterion fails (exit 1, run exit 4).

## What the earlier record got wrong

`2026-09-07-initial/README.md` stated the Claude Code half was blocked because the runtime held no
usable credential and only an interactive login could restore it. Two things were wrong:

- The credential had genuinely expired at the time of that recording, but the record presented a
  transient environment state as a property of the demonstration.
- The gate that detected it was defective: it read `account.tokenSource`, which claude 2.1.260
  **omits when signed in with claude.ai**. So the gate reported "no usable credential" on a fully
  authenticated account and stamped that false reason into the evidence. All three independent
  verifiers reproduced acceptance through the installed runtime and rejected the claim.

This is the same class of error R0 shipped: a status asserted as fact that the implementation did not
establish. Both records are kept so the mistake stays visible.

## Limitations this record does not hide

- **AT03's stronger reading is met; FR042 is not claimed.** Claude Code has no OS sandbox. Its write
  scope is bounded by the tool surface and `--add-dir`, which is a permission boundary, not a
  containment boundary. Run B is accepted *with* that gap recorded, not in spite of it.
- **Two samples.** No latency distribution, and no comparison against using either CLI directly.
- **One task, one small fixture.** Nothing here establishes behaviour on a real codebase.
- **No coordination.** No planner, reviewer, peer message, handoff, or repair loop runs here; those
  are WP06–WP09.
- The Codex `input_tokens` figure (136 283) reflects that runtime's full-context accounting; the
  Claude figure (10) is what its result record reports. They are not directly comparable.

## Files

`agents.json` · `transcript-codex.txt` · `transcript-claude.txt` · `manifest-codex.json` ·
`manifest-claude.json` · `summary-codex.md` · `summary-claude.md` · `candidate-codex.patch` ·
`candidate-claude.patch` · `events-codex.jsonl` · `events-claude.jsonl` · `facts.txt`

## Superseded records, kept intact

| Directory | What it is, and what it got wrong |
| --- | --- |
| `2026-09-07-initial/` | The first AT03 attempt. Reported the **Claude Code** half as blocked by a dead credential. The credential had genuinely expired, but the record presented a transient environment state as a property of the demonstration, and the gate that detected it was itself defective. |
| `2026-09-07-codex-signed-out/` | The re-recording after the Claude credential was restored. It made the **same mistake with the runtimes swapped**, stating as present-tense fact that "the installed Codex runtime cannot be run today at all" because the ChatGPT sign-in had expired. It expired during that window and was restored by the user before the record above was made. **This directory also holds evidence that remains valid and is not superseded**: the `.gitattributes` `export-ignore` acceptance-escape attack and its refusal (`attack-export-ignore.txt`, `manifest-export-ignore-attack.json`, `scenario-fake-export-ignore.json`), the Claude rewrite-tests attack, and the `fake-run.mjs` / `replay-run.mjs` harnesses. |

Both CLIs' OAuth sessions expired at different points during this project. That is a property of the
machine on the day, not of either adapter, and no record here should state either sign-in's status as
a durable fact.
