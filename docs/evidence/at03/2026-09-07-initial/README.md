> **Superseded — kept for the record, not as a current claim.** Independent verification of this
> record found its central claim false. It says the Claude Code half of AT03 is blocked because the
> installed `claude` "holds no usable credential" and that only an interactive `claude auth login`
> could restore it. The same task, on the same machine, with no login performed, reaches `accepted`
> through the installed `claude 2.1.260` with a real model turn. The diagnosis was an inverted
> reading of the runtime's own handshake: claude 2.1.260 reports `account.tokenSource: "none"` when
> it is signed **out** and omits the field entirely when it is signed **in**, and this record — plus
> the test gate, the capability table and the conformance target it was written from — read the
> absent field as a denial. Everything downstream of that reading is wrong with it: the "blocked"
> status, the replay-substitute apparatus presented as necessary, the five `supported_unverified`
> capability statuses, and the promise that the skipped checks "un-skip themselves" after a login.
>
> What the runs recorded here *did* observe is unaffected: run A's Codex fix is real, run B really
> did fail authentication at 18:44 that day (`events-claude.jsonl` holds the
> `authentication_failed` event), and runs C and D really did exercise the adapter. Nothing in this
> file has been edited. See `../README.md` for the current record.

# AT03 evidence — the same fixture task through both installed runtimes

Release gate: **R1** · Acceptance test: **AT03** · Work package: **WP05 — second adapter**, integrated
into `main` · Features exercised: **FR003, FR004, FR005, FR006, FR011, FR012, FR041, FR042, FR049,
FR050, FR058, FR059, FR060**

Recorded 7 September 2026 on the author's macOS machine. Everything below was executed; every number
comes from a file in this directory. Where a statement is not backed by an executed command it says so.

---

## The headline, before anything else

**Half of this demonstration passed and half is blocked, and the blocked half is not a code defect.**

- The fixture task reached `accepted` through the **installed Codex runtime**, exit 0, on a candidate
  a verifier-executed check passed and whose patch really fixes the bug. That is run **A**.
- The identical task through the **installed Claude Code runtime** did not reach `accepted`. The run
  worked exactly as designed — session opened, turn started, event stream normalized, evidence
  recorded, acceptance refused — but the runtime itself could not reach the provider. Every turn on
  this machine ends in about 50 ms with
  `Failed to authenticate: OAuth session expired and could not be refreshed`. That is run **B**, and
  it exits 4.

`claude auth status` on this machine now reports `{"loggedIn": false, "authMethod": "none"}`, and the
runtime's own `initialize` handshake reports `account.tokenSource: "none"`. Restoring it needs
`claude auth login`, an interactive browser sign-in a coding agent must not perform on the user's
behalf. Nothing in this repository can work around it.

So, stated precisely:

| Reading of AT03 | Status |
| --- | --- |
| The plan's own wording (§12): "Both Codex and Claude Code pass adapter lifecycle/conformance tests, including stream/result parsing and owned session continuity" | **Partly.** Both adapters run the same shared conformance suite against their installed executables. Codex passes every check but one documented skip. Claude Code passes every check that does not need a completed model turn; the eight that do are skipped with the credential as the stated reason. A skipped check is not a passing check. |
| The stronger demonstration this package was asked for: the same task `accepted` through both installed runtimes | **No.** Codex yes; Claude Code blocked on the runtime's credential. |

What *is* established for the Claude Code side, with the code path the product actually uses:

- run **C**: the same task, the same `commandRun` coordinator, the same real `ClaudeCodeAdapter` —
  with the adapter's executable pointed at the deterministic recorded-replay binary instead of the
  installed `claude`. It reaches `accepted`, exit 0, and its patch really fixes the bug. **No model
  turn happened. This is not evidence that Claude Code fixed anything.** It is evidence that
  everything between the coordinator and the runtime's stdio is complete, so that when a credential
  exists the only untested link is the model's own work.
- run **D**: the acceptance-surface attack down that same claude-code path — a worker that rewrites
  the acceptance suite instead of fixing the bug. Refused, exit 4.

---

## Source revision that produced this evidence

**Commit: `d05bbae` — "AT03 evidence: the same task accepted via Codex and Claude Code"**, whose
parent is `2d9a910` ("Merge WP05 (Claude Code adapter) into main"). `dist/` was built with
`npm run build` from that commit's `src/`, and nothing under `src/` or `fixtures/` changed between
that build and these runs. (`tests/` gained one file-scoped hygiene fix afterwards, described at the
end of this file; it cannot affect a `dist/` run.)
`npm run typecheck`, `npm test` and the gated real-runtime suites were run against the same tree, and
`checks.txt` is their verbatim output:

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean, exit 0 |
| `npm test` | **370 passed, 31 skipped**, 27 files passed / 2 skipped, exit 0 |
| `WORKFORCE_REAL_RUNTIMES=1 npx vitest run tests/adapters --reporter=verbose` | **200 passed, 11 skipped**, 7 files passed, exit 0 |

The 11 skips in the real-runtime run are each named with its reason in `checks.txt`:

| Skips | Reason |
| --- | --- |
| 6 | `claude-code model turns` — the installed runtime holds no usable credential |
| 2 | claude-code conformance: *one active turn per session*, *delivery into an active turn* — no turn can be kept running without a credential; the recorded-replay target covers both |
| 2 | *unknown and malformed output*, one per installed runtime — neither can be made to emit malformed frames on demand; each is covered by a recorded replay |
| 1 | the replay target's passive probe — the replay binary is not the `claude` executable, so there is nothing to probe |

**A skipped check is not a passing check**, and those first eight are exactly where AT03's Claude
Code half stands.

`main` at the time of the runs: the WP05 merge (`Merge WP05 (Claude Code adapter) into main`) plus
the FR006 effective-settings change described under [What changed in the code for this
record](#what-changed-in-the-code-for-this-record).

## Environment

| Fact | Value |
| --- | --- |
| Codex | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex`, ChatGPT sign-in, `verified_ready` |
| Claude Code | `claude 2.1.260` at `~/.local/bin/claude`, **`logged_out`**, `account.tokenSource: "none"` |
| Node | v26.8.1 · Git 2.50.1 · darwin 25.6.0, arm64 |
| Model pinned for `codex-local` | `gpt-5.6-sol` / effort `medium` (from `model/list`) |
| Model pinned for `claude-local` | `sonnet` / effort `medium` (from the runtime's own model list) |

The Codex model is pinned deliberately: this machine's `~/.codex/config.toml` defaults to
`gpt-6-astra`, which `codex-cli 0.147.0` rejects with HTTP 400.

`doctor-connect.json` is `workforce doctor --connect --json` against both runtimes — a live control
handshake per runtime, no model turn — and is where the readiness verdicts above come from. It says
`codex: verified_ready` and `claude-code: controllable` with the diagnostic
*"the runtime reports account.tokenSource \"none\": it holds no usable credential, whatever
`claude auth status` says."*

## The agent configuration

`agents.json` declares **both** runtimes and binds one agent to each:

```json
"runtimes": {
  "codex-local":  { "adapter": "codex",       "executable": "/opt/homebrew/bin/codex",              "model": "gpt-5.6-sol", "effort": "medium" },
  "claude-local": { "adapter": "claude-code", "executable": "/Users/…/.local/bin/claude",           "model": "sonnet",      "effort": "medium" }
},
"agents": [ { "id": "engineer-codex", "runtime": "codex-local", … }, { "id": "engineer-claude", "runtime": "claude-local", … } ]
```

Both agents carry the same instructions and the same `local-development` policy. Only the runtime
binding differs — which is FR012, and the reason the two runs below are comparable at all.

## What was run

The fixture is materialized into a throwaway Git repository per run, because a run creates branches
and worktrees and the verifier executes repository code. `fixtures/ts-bug` itself is never touched.

```sh
ROOT=$(mktemp -d)
npx tsx materialize.mts "$ROOT/repo-codex"          # → base ea90433a57c6 on branch main
npx tsx materialize.mts "$ROOT/repo-claude"         # → base 0c96effc4902
npx tsx materialize.mts "$ROOT/repo-claude-replay"  # → base 0c96effc4902
npx tsx materialize.mts "$ROOT/repo-claude-attack"  # → base d7e90e3402ee
( cd "$ROOT/repo-<each>" && node --test test/ )     # → exit 1 in all four: the bug reproduces

# A — the installed Codex runtime
node dist/cli/index.js run --repo $ROOT/repo-codex --agents $ROOT/agents.json \
  --agent engineer-codex --state-dir $ROOT/state-codex --task "$(cat $ROOT/task.txt)"

# B — the installed Claude Code runtime, same task text, its own state dir
node dist/cli/index.js run --repo $ROOT/repo-claude --agents $ROOT/agents.json \
  --agent engineer-claude --allow-unconfined-writes --state-dir $ROOT/state-claude \
  --task "$(cat $ROOT/task.txt)"

# C, D — the same coordinator and the same ClaudeCodeAdapter, executable = the replay binary
node replay-run.mjs $ROOT/repo-claude-replay $ROOT/agents.json $ROOT/state-claude-replay \
  $ROOT/task.txt fixtures/claude-code/session-fix-pagination.synthetic.json "$(cat vars-fix.json)"
node replay-run.mjs $ROOT/repo-claude-attack $ROOT/agents.json $ROOT/state-claude-attack \
  $ROOT/task.txt scenario-claude-rewrite-tests.json '{}'
```

The task text is the fixture's bug report, verbatim (`task.txt`, from `fixtures/ts-bug/README.md`):

> The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2
> pages, so page 3 is never requested and the last match is never shown. `paginate()` also returns
> one item too few on every page. Find the cause and fix it. `npm test` reproduces it.

No acceptance check was passed on the command line. All four runs resolved `.workforce/checks.json`
**from the base revision** — `node --test test/` — and pinned the files that definition executes, so
a worker that rewrites them cannot pass. Run D is that attack.

### Why run B needs `--allow-unconfined-writes` and run A does not

`claude-code` reports `write_containment: unsupported` for 2.1.260 on darwin, so the run path
*refuses* a writing profile on it unless a human explicitly accepts an unconfined run. That refusal
is WP05's finding, not a workaround: a SessionStart hook the installed runtime itself launched wrote
outside every `--add-dir` directory, wrote to `/tmp`, read outside and reached the network — with and
without `--restricted --permission-mode plan --permission-prompts none`. Codex needs no such flag
because its `workspaceWrite` sandbox with `excludeSlashTmp`/`excludeTmpdirEnvVar` is `verified`.

This is the single largest behavioural difference a user would notice between the two runtimes, and
it is the first thing `transcript-claude.txt` prints.

## Results

| | **A** codex (real) | **B** claude-code (real) | **C** claude-code (replay) | **D** claude-code attack (replay) |
| --- | --- | --- | --- | --- |
| run id | `01a07bf5-7769-70c5-9a94-123f82562ef4` | `01a07bff-9d26-7041-addb-9b75b69f8c9a` | `01a07bff-d96a-750d-bd94-8b0ac8251501` | `01a07bff-db7b-7021-9eab-0e500bb71387` |
| exit code | **0** | **4** | **0** | **4** |
| outcome | `accepted` | `failed` | `accepted` | `failed` |
| base | `ea90433a57c6` | `0c96effc4902` | `0c96effc4902` | `d7e90e3402ee` |
| candidate | `6a94ca7c8105` | none (identical to base) | `c2284267eb37` | `03c031e8b59e` |
| patch sha256 | `2a4859774b60…` | `e3b0c44298fc…` (empty) | `0ca76d6e018e…` | `19bdbba6e5c5…` |
| changed files | `M src/pagination.js` | none | `M src/pagination.js` | `M test/pagination.test.js` |
| check `node-tests-pass` | passed, exit 0, 77 ms, 5 tests | failed, exit 1, 81 ms, 5 tests | passed, exit 0, 83 ms, 5 tests | passed, exit 0, 77 ms, **1 test** — and **compromised** |
| evidence provenance | `verifier_executed` | `verifier_executed` | `verifier_executed` | `verifier_executed` |
| requested → effective model | `gpt-5.6-sol` → `gpt-5.6-sol` | `sonnet` → **`claude-sonnet-5`** | `sonnet` → `claude-opus-5[1m]` (the scenario's) | same |
| worker shell commands | 4 | 0 | 0 | 0 |
| runtime errors | 0 | 1 (`authentication_failed`) | 0 | 0 |

Run A's patch is byte-identical to the R0 recording's (`sha256 2a4859774b60…`): `Math.floor` →
`Math.ceil` in `pageCount`, and the `- 1` removed from the `slice` end in `paginate`, with the BUG
comments deleted. That is a property of this fixture, not a reproducibility guarantee.

### Timing split (FR060)

| phase | A codex (real) | B claude-code (real) | C claude-code (replay) |
| --- | --- | --- | --- |
| dispatch — intent committed → worker dispatchable | 144 ms | 151 ms | 150 ms |
| runtime startup — `openSession` incl. the runtime's own handshake | **1 010 ms** | **548 ms** | 37 ms |
| model/runtime turn | **86 964 ms** | 47 ms *(no provider call)* | 5 ms |
| validation — freeze + contained check | 181 ms | 161 ms | 184 ms |
| **elapsed, submission → result** | **89 341 ms** | 1 432 ms | 380 ms |

### Usage and cost availability

| | A codex | B claude-code (real) | C claude-code (replay) |
| --- | --- | --- | --- |
| status | `measured` | `measured` | `measured` |
| input / output tokens | 195 314 / 1 935 | 0 / 0 | 1 200 / 40 |
| cost (USD) | **`null`** — the app server reports no price at all | **`null`** | `0.0123` |

Codex reports token counts and no currency figure ever, so cost is `null` with a source line saying
so — never zero. Claude Code *does* report `total_cost_usd`, and the adapter decides whether that
number is a measurement: in run B the turn made no provider call (`duration_api_ms` is 0), so the
reported cost is discarded and recorded as unavailable; in run C the scenario's result record carries
a cost for a turn that reached a provider, so it is recorded. Run B's `0 / 0` tokens are the zeros
the runtime itself reported for a turn that never called the provider — the number is real, the turn
is not.

## Honest comparison of the two runtimes

Two runs are **observations, not a benchmark**. One machine, one fixture, one sample each, warm
caches, and the Claude Code sample never reached a model at all. Nothing here supports a
distributional claim, a p95, or "runtime X is faster".

| Dimension | Codex 0.147.0 | Claude Code 2.1.260 | What a user would notice |
| --- | --- | --- | --- |
| Startup (`openSession` → usable session) | 1 010 ms | 548 ms | Codex is ~2× slower to open here, and most of that is the *user's own MCP servers*, which start with every Codex thread and which the adapter cannot suppress on this version. Claude Code is passed `--strict-mcp-config`, so it starts none. |
| Turn time | 86 964 ms for the full fix | not measurable | Not comparable. Run A is a real multi-step fix; run B is an authentication failure. |
| Total accepted-result latency | 89.3 s | — | Only Codex produced one. A second, earlier run of the identical Codex command on this machine took 61.0 s with 135 261 input tokens; its artifacts are not part of this record, but it is the honest indication of how much run-to-run variance one fixture shows. |
| Cost availability | tokens only, **never** a price | tokens **and** `total_cost_usd`, when the turn reached the provider | Claude Code is the only one of the two from which a per-turn currency figure can be reported at all. |
| Write containment | `verified` — kernel-enforced writable roots, `/tmp` and `$TMPDIR` excluded | `unsupported` — no OS sandbox; a hook it launched escaped every granted directory | The visible difference: a `local-development` run on Claude Code is **refused** unless the operator passes `--allow-unconfined-writes`, and the manifest, the summary and the terminal all say the run was unconfined. |
| Session/turn shape | request/response app server; `turn/steer` mid-turn; `turn/interrupt` with an observed confirmation | a turn *is* a stdin frame; interrupts and model listing ride a small control protocol on the same pipes | Invisible through the CLI: the shared adapter contract absorbs it. That is the point of the conformance suite. |
| Effective settings | echoes model and effort in the `thread/start` response | echoes the model in each turn's `system.init` record; **no effort** | `sonnet` was recorded as effectively `claude-sonnet-5`. An alias the configuration writes is not the model that ran, and the manifest now says both. |
| Event volume for the same task | 80 unnormalized runtime events kept verbatim beside the normalized stream | 1 | Codex emits far more (MCP startup, reasoning items, rate-limit and diff notifications); none of it is dropped. |

## What was verified, and how

`verification.txt` is the raw output of the checks below, run **outside the coordinator** against the
files each run left behind. Every claim here is a line in that file.

**1 — Acceptance came only from a verifier-executed receipt on the frozen candidate.** For every run,
`checks[].evidenceProvenance` is `verifier_executed` and `copyStrategy` is `git_archive`: the check
ran in a separate throwaway copy of the frozen candidate revision, under an environment cut to
`HOME`, `PATH`, `TMPDIR`. The receipt's own `candidate.revision` and `candidate.patchHash` equal the
manifest's, and `sha256(candidate.patch)` equals both. The integrity scan over all 6 tracked files
reports `mutated: false`, with the same tree hash before and after. `node --test` reported **5 tests**
in runs A, B and C, so an exit-0 run that executed nothing could not pass for this — and run D's receipt records `testsRun: 1`, the single empty test its rewritten suite
contained. The runtime's "done" claim is recorded as `evidence.runtimeClaimedDone` and decides
nothing: it is `true` in run A, which was accepted because a check passed, and `false` in runs B, C
and D — including run C, which was accepted anyway, and run D, whose check *passed* and was still
refused.

**2 — The accepted patch actually fixes the bug, checked twice.** A clean `git archive` of the base
fails `node --test` (exit 1). `git apply candidate.patch` applies cleanly (exit 0). The patched copy
then passes (exit 0). **And then the acceptance suite is restored from the base revision over the
patched source and run again** — because "the patched copy passes its own tests" is exactly what a
rewritten suite would also produce. Runs A and C pass that second check (exit 0). Run D fails it
(exit 1), which is precisely the attack being caught.

**3 — No temp repository's branch or working tree was touched.** After all four runs each repo
is still on `main` at its base revision, `git status --porcelain` is empty, `src/pagination.js` still
contains `Math.floor`, and `main`'s reflog holds exactly one entry — the fixture import. No `reset`,
`clean` or `stash` was run against any of them. Each run left one extra branch,
`workforce/<run>/<task>/<attempt>`.

**4 — The checkpoint commit is the coordinator's, never the user's.** Runs A, C and D each have a
checkpoint commit authored **and** committed by `workforce coordinator <coordinator@workforce.invalid>`,
with the base revision as its parent. The machine's own Git identity
(`Shebin Mohan K <shebin.m@…>`) appears nowhere. Run B has `checkpointCreated: false` — the worker
changed nothing, so its candidate branch simply names the base commit, whose author is the fixture
import identity; `verification.txt` labels that case explicitly rather than letting it read as a
coordinator commit.

**5 — The manifest records the runtime and the effective model.** Each manifest's `runtime` block
carries `adapter`, `runtimeId`, `executable`, the requested `model`/`effort` with their validation
status, and — new for this record — `effectiveModel`, `effectiveEffort` and
`effectiveSettingsSource`. In run B, requested `sonnet` versus effective `claude-sonnet-5` is a real
difference the manifest could not previously express.

**6 — The evidence files exist.** Each run directory holds `request.json`, `contract.json`,
`config-snapshot.json`, `events.jsonl`, `artifacts/result.json`, `artifacts/summary.md`,
`artifacts/candidate.patch`, the check receipt with its stdout/stderr logs, and the adapter's raw
stdio capture (`artifacts/logs/…jsonl`). Run A's event projection has 109 records, run B's 15.

## The acceptance-surface attack against the claude-code path

**Which one was run: the deterministic version.** The installed `claude` cannot complete a turn on
this machine, so it cannot be steered into misbehaving at all; and even with a credential, driving a
real model into rewriting a test suite on demand is neither cheap nor reproducible. Run D therefore
uses the **real `ClaudeCodeAdapter` and the real coordinator**, with the adapter's executable pointed
at `fixtures/claude-code/fake-claude.mjs` replaying `scenario-claude-rewrite-tests.json` — the same
technique WP05 uses for its recorded-replay conformance target, and the same technique the R0 record
used against the fake runtime. What is exercised is the coordinator's decision path and the
claude-code adapter's event normalization; what is *not* exercised is a model choosing to cheat.

The scenario leaves `src/pagination.js` untouched and rewrites `test/pagination.test.js` to a single
empty test, then claims success. The result (`attack-claude.txt`):

```
  tool Write -> ok
  changed test/pagination.test.js
  check node-tests-pass: passed (exit 0) in 77ms
not accepted: criterion "node-tests-pass" passed (exit 0, 77ms), but the candidate changed the files
this criterion executes (M test/pagination.test.js), so the result does not establish the criterion
the base revision defined
run …: failed          COMP node-tests-pass          # exit code 4
```

The check *passed* and the run was still refused: `COMP` is a third status, neither pass nor ordinary
failure. `verification.txt` run D confirms the attack was real — the patched source fails the base
revision's suite (exit 1) — and that the coordinator caught it anyway.

## What changed in the code for this record

One change, in `main`, to satisfy "the manifest records the runtime and the effective model":

- `src/adapters/types.ts` — a new optional shared-contract method
  `RuntimeAdapter.effectiveSettings(session)` returning `EffectiveRuntimeSettings { model, effort? }`.
  Both real adapters already captured what their runtime echoed back, but into **adapter-shaped
  accessors the coordinator could not read** — the exact mistake `lastTurnUsage` exists to avoid.
- `src/core/run-direct.ts` — reads it and records `effectiveModel`, `effectiveEffort` and
  `effectiveSettingsSource` (`runtime_reported` | `not_reported`) in the manifest and the summary,
  and prints a terminal note when the effective model differs from the requested one. An adapter that
  does not implement the method yields `not_reported` — never the requested value repeated as if it
  had been confirmed.
- `src/adapters/fake/adapter.ts` — implements it from the fake runtime's own `session_started` echo.
- Tests: one conformance check (runs against all four targets, and starts no turn, so a real target
  is not charged for it) and three behavioural tests in `tests/run/direct.test.ts`.

And one test-hygiene fix that this record forced: `tests/adapters/claude-code/real-runtime.test.ts`
used `describe.skipIf(REAL)` for its "gate is off" placeholder, so a run *with* the gate on still
reported a skip whose stated reason was "set `WORKFORCE_REAL_RUNTIMES=1`". The placeholder is now
defined only when the gate is off. No check was weakened — the message simply contradicted the
command that produced it, which a recorded suite must not do.

It earned its place immediately: `sonnet` → `claude-sonnet-5` in run B, and the runtime *default*
recorded for a run that requested nothing, which the `model` field structurally cannot express.

## Limitations this record does not hide

- **The Claude Code half of AT03 is not demonstrated.** Runs C and D exercise the coordinator and the
  adapter, not the model. No claim is made here that Claude Code can fix this bug, or how long it
  would take, or what it would cost.
- **Run C's manifest names the wrong executable.** It records
  `runtime.executable: "/Users/…/.local/bin/claude"` because that is what `agents.json` configured;
  the process actually spawned was `node fixtures/claude-code/fake-claude.mjs`, substituted by
  `replay-run.mjs` at the adapter-factory level. The manifest records the configured binding, not the
  adapter's overridden executable. Read `transcript-claude-replay.txt` and `replay-run.mjs`, not the
  manifest's `executable` field, for what ran.
- **Runs C and D are synthetic, and their `total_cost_usd` is a made-up number** in a scenario file.
  It is real enough to prove the adapter reports cost through the shared contract; it is not a price
  anyone paid.
- **The replay scenarios are not recordings.** `fixtures/claude-code/session-fix-pagination.synthetic.json`
  and `scenario-claude-rewrite-tests.json` use record shapes taken from
  `session-auth-failure.real.json`, which is a real transcript — but no turn on this machine ever
  reached the model, so the *content* is written, not captured. Both files say so in their own
  `provenance` field.
- **Run B tells you nothing about Claude Code's normal behaviour.** It measures a 47 ms
  authentication failure. Its startup number (548 ms) is real; its turn number is not a turn.
- **No enforced execution boundary (FR042) is claimed for either run.** The verifier runs repository
  tests with this user's own privileges; only the environment is sanitized and the candidate is a
  throwaway copy. Codex's sandbox bounds the *worker's* writes and network, not reads, and not the
  verifier. Claude Code bounds neither, which is why run B needed an explicit flag.
- **Two samples, one fixture.** Nothing here establishes a latency distribution, a dispatch-overhead
  percentile, or a comparison against using either runtime directly.
- **`modelStatus` is `supported_unverified` in every run.** The run path does not call the runtime's
  model listing before dispatching, so a pinned value is passed through unvalidated and reported
  honestly as unverified. `effectiveModel` is what closes that gap after the fact, not before.
- **The Codex startup figure includes the user's own MCP servers.** They start with every Codex
  thread and this version gives the adapter no way to suppress them, so the two startup numbers are
  not a like-for-like measurement of the two CLIs.
- **Run A's four `exec` calls ran under `/bin/zsh -lc`**, which is Codex's own shell tooling inside
  its sandbox, not a shell string this coordinator built. The coordinator spawns only
  `spawn(executable, argv, { shell: false })`.

## Redaction

No credential, token or key appears in any file here. Each was scanned for bearer tokens, `sk-`,
`ghp_`, `xox*`, `AKIA*` and JWT-shaped strings; there are no matches.

`doctor-connect.json` is the one edited file: each runtime's `searchedLocations` array — the
recording machine's full `PATH` plus known install locations, naming unrelated local tooling and
per-session directories — was replaced by a one-line note giving the count (61 each). Everything else
in it is verbatim. Absolute paths are kept elsewhere because they are what makes the record
reproducible: the two runtime executables, this repository, and the throwaway `$ROOT` the runs used
(a scratch directory under `$TMPDIR`, outside this repository, deleted after the evidence was copied
out of it).

## Files

| File | What it is |
| --- | --- |
| `transcript-codex.txt` | run A: the command, full stdout+stderr, exit code, start and finish times |
| `transcript-claude.txt` | run B: the same, for the installed Claude Code runtime |
| `transcript-claude-replay.txt` | run C: the supplementary replay-driven run |
| `attack-claude.txt` | run D: the acceptance-surface attack, refused |
| `manifest-codex.json` | run A `artifacts/result.json` — the portable run report (FR059) |
| `manifest-claude.json` | run B's manifest |
| `manifest-claude-replay.json` · `manifest-claude-attack.json` | runs C and D |
| `candidate-codex.patch` | run A's candidate: the accepted fix |
| `candidate-claude.patch` | run B's candidate — **empty, 0 bytes**: the worker changed nothing |
| `candidate-claude-replay.patch` · `candidate-claude-attack.patch` | runs C and D |
| `summary-codex.md` · `summary-claude.md` | the human-readable run reports |
| `events-codex.jsonl` · `events-claude.jsonl` | the durable event projections (FR058) |
| `verification.txt` | raw output of checks 1–6 above, for all four runs |
| `checks.txt` | `npm run typecheck`, `npm test` and `WORKFORCE_REAL_RUNTIMES=1 npx vitest run tests/adapters`, verbatim |
| `doctor-connect.json` | `workforce doctor --connect --json` for both runtimes; `searchedLocations` omitted |
| `agents.json` | the configuration all four runs used: both runtimes, one agent each (FR011, FR012) |
| `task.txt` | the task text, the fixture's bug report verbatim |
| `verify.sh` | the verification script that produced `verification.txt` |
| `replay-run.mjs` | the driver for runs C and D: real coordinator, real adapter, replay executable |
| `scenario-claude-rewrite-tests.json` | run D's scenario — synthetic, and it says so |

## Reproducing

```sh
npm run build
# then the commands under "What was run", with your own $ROOT
```

A real Codex run spends ChatGPT quota; run ids, revisions, patches and timings will differ. The
Claude Code half will keep failing the same way until someone runs `claude auth login` on this
machine — after which the six skipped real-runtime checks un-skip themselves (they ask the runtime
for its `tokenSource` before the tests are defined) and run B can be repeated as written.
