# AT03 evidence — the same fixture task through the installed Claude Code runtime

Release gate: **R1** · Acceptance test: **AT03** · Work package: **WP05 — second adapter**, integrated
into `main` · Features exercised: **FR003, FR004, FR005, FR006, FR011, FR012, FR041, FR042, FR049,
FR050, FR058, FR059, FR060**

Re-recorded 7 September 2026 on the author's macOS machine, after independent verification found the
first AT03 record's central claim false. The first recording is kept unchanged in
[`2026-09-07-initial/`](2026-09-07-initial/) with a banner saying what was wrong with it.
Everything below was executed; every number comes from a file in this directory. Where a statement
is not backed by an executed command it says so.

---

## The headline, before anything else

**The installed Claude Code runtime fixes the fixture bug and the run reaches `accepted`, exit 0.
The installed Codex runtime cannot be run today at all: this machine's ChatGPT sign-in has expired.**

That is the exact reverse of what the first record said, and the reversal has two different causes
that should not be confused:

1. **The Claude Code half was never blocked.** The first record said the installed `claude` "holds
   no usable credential" and that only an interactive `claude auth login` could restore it. That
   diagnosis was wrong. claude 2.1.260 reports `account.tokenSource: "none"` when it is signed
   **out** and **omits the field entirely** when it is signed **in**; the adapter, the test gate,
   the capability table and the conformance target all read the absent field as a denial. Executed
   here, with no login performed, the `initialize` account block is
   `{"email": …, "organization": …, "subscriptionType": "Claude Max", "apiProvider": "firstParty"}`
   and there is no `tokenSource` key at all. The reading is fixed in code
   (`readClaudeCredential`, `src/adapters/claude-code/protocol.ts`), and run **B** below is what the
   runtime does when it is asked properly.
2. **The Codex half is blocked now, by the machine, not by this code.** `codex login status` reports
   `Not logged in`, and run **A** ends in `unexpected status 401 Unauthorized … url:
   https://api.openai.com/v1/responses`. The run behaves correctly — session opened, stream
   normalized, evidence recorded, acceptance refused, exit 4 — but no model did any work. Restoring
   it needs an interactive `codex login`, which a coding agent must not perform on the user's
   behalf. **No claim is made here about what Codex would do today.**

So, stated precisely:

| Reading of AT03 | Status |
| --- | --- |
| The plan's own wording (§12): "Both Codex and Claude Code pass adapter lifecycle/conformance tests, including stream/result parsing and owned session continuity" | **For Claude Code, yes:** 17 of 17 real-runtime checks pass with no skip, and 19 of 20 shared conformance checks pass against the installed executable (the 20th is the malformed-output check, which no installed runtime can be made to produce on demand; the recorded replay covers it). **For Codex, not today:** its 12 gated checks fail on HTTP 401 because the sign-in expired. The Codex half passed on this machine when WP03 and the first AT03 record were made; `2026-09-07-initial/checks.txt` is that run. |
| The stronger demonstration: the same task `accepted` through the installed runtime | **Claude Code: yes** (run B, exit 0, a real model turn, a patch proved outside the coordinator to fix the bug). **Codex: not today.** |

Nothing here is a two-runtime comparison. One runtime worked when this was recorded.

---

## Source revision that produced this evidence

**Commit: "Address WP05/AT03 verification findings"**, whose parent is `8a97b87`
("AT03 evidence: say accurately what happened to the scratch directory"). `dist/` was built with
`npm run build` from that commit's `src/`, and nothing under `src/` or `fixtures/` changed between
that build and these runs — with one exception, named here rather than glossed over: after the runs,
the doc comment on `turnConclusion` in `src/core/run-direct.ts` was reworded to mention Codex's
`status: "failed"` beside Claude Code's `is_error`, because run A had just demonstrated the Codex
shape. It is a comment; no statement changed, and the commit is the tree with the reworded comment in
it. (`tsc` keeps comments in its output, so `dist/core/run-direct.js` is not byte-identical across
that edit even though its behaviour is.)

| Command | Result | File |
| --- | --- | --- |
| `npm run typecheck` | clean, exit 0 | `checks.txt` |
| `npm test` | **381 passed, 31 skipped**, 27 files passed / 2 skipped, exit 0 | `checks.txt` |
| `WORKFORCE_REAL_RUNTIMES=1 npx vitest run tests/adapters --reporter=verbose` | **201 passed, 12 failed, 3 skipped**, exit 1 | `checks.txt` |

The gated suite does not pass, and the reason is named rather than hidden: **all 12 failures are
Codex**, six in `tests/adapters/codex/real-runtime.test.ts` and six in the codex conformance target,
each one a 401 or a timeout waiting for a turn that never reaches the provider. Every claude-code
check in the same run passes.

Only three checks are skipped now, down from eleven:

| Skips | Reason |
| --- | --- |
| 1 | claude-code conformance, *unknown and malformed output* — the installed runtime cannot be made to emit malformed frames on demand; the recorded-replay target covers it |
| 1 | codex conformance, the same check for the same reason |
| 1 | the replay target's passive probe — the replay binary is not the `claude` executable, so there is nothing to probe |

The eight skips that are gone were the ones the first record described as "exactly where AT03's
Claude Code half stands": six model-turn checks and two conformance checks. They were not skipped
because of a credential. Six skipped on the inverted `tokenSource` reading, and two on a
`slowSkipReason` string literal in `tests/adapters/conformance/targets.ts` that no environment could
ever clear — the target simply supplied no long-running session, so those checks could not run on any
machine. A third check was worse than skipped: `suite.ts` registered **one** `it.skip` for a branch
whose else-arm defines **two** tests, so *"an interrupt receipt says observed only when the turn
actually ended"* was silently dropped from every report for that target. Both are fixed.

## Environment

| Fact | Value |
| --- | --- |
| Claude Code | `claude 2.1.260` at `~/.local/bin/claude`, **`logged_in`** (claude.ai, Claude Max), `verified_ready` |
| Codex | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex`, **`logged_out`** — `codex login status` prints `Not logged in` |
| Node | v26.8.1 · Git 2.50.1 · darwin 25.6.0, arm64 |
| Model pinned for `claude-local` | `sonnet` / effort `medium` (from the runtime's own model list) |
| Model pinned for `codex-local` | `gpt-5.6-sol` / effort `medium` (from `model/list`) |

The Codex model is pinned deliberately: this machine's `~/.codex/config.toml` defaults to
`gpt-6-astra`, which `codex-cli 0.147.0` rejects with HTTP 400.

`doctor-connect.json` is `workforce doctor --connect --json` against both runtimes — a live control
handshake per runtime, no model turn. It reports `claude-code: verified_ready` / `logged_in` and
`codex: controllable` / `logged_out`. In the superseded record those two verdicts are the other way
round.

## The agent configuration

`agents.json` declares both installed runtimes plus the deterministic fake one, and binds one agent
to each:

```json
"runtimes": {
  "codex-local":  { "adapter": "codex",       "executable": "/opt/homebrew/bin/codex",    "model": "gpt-5.6-sol", "effort": "medium" },
  "claude-local": { "adapter": "claude-code", "executable": "/Users/…/.local/bin/claude", "model": "sonnet",      "effort": "medium" },
  "fake-local":   { "adapter": "fake",        "executable": "fixtures/fake-runtime/fake-runtime.mjs" }
}
```

All three agents carry the same instructions and the same `local-development` policy. Only the
runtime binding differs — which is FR012.

## What was run

The fixture is materialized into a throwaway Git repository per run, because a run creates branches
and worktrees and the verifier executes repository code. `fixtures/ts-bug` itself is never touched.

```sh
ROOT=$(mktemp -d)
npx tsx materialize.mts "$ROOT/repo-claude"          # → base ebaaa31f652f on branch main
npx tsx materialize.mts "$ROOT/repo-codex"           # → base ebaaa31f652f
npx tsx materialize.mts "$ROOT/repo-claude-attack"   # → base 17694a47fd26
npx tsx materialize.mts "$ROOT/repo-archive-attack"  # → base 17694a47fd26
( cd "$ROOT/repo-<each>" && node --test test/ )      # → exit 1 in all four: the bug reproduces

# B — the installed Claude Code runtime
node dist/cli/index.js run --repo $ROOT/repo-claude --agents $ROOT/agents.json \
  --agent engineer-claude --allow-unconfined-writes --state-dir $ROOT/state-claude \
  --task "$(cat $ROOT/task.txt)"

# A — the installed Codex runtime, same task text, its own state dir
node dist/cli/index.js run --repo $ROOT/repo-codex --agents $ROOT/agents.json \
  --agent engineer-codex --state-dir $ROOT/state-codex --task "$(cat $ROOT/task.txt)"

# D, E — the two acceptance-surface attacks, through the same coordinator entry point
node replay-run.mjs $ROOT/repo-claude-attack  $ROOT/agents.json $ROOT/state-claude-attack \
  $ROOT/task.txt scenario-claude-rewrite-tests.json '{}'
node fake-run.mjs   $ROOT/repo-archive-attack $ROOT/agents.json $ROOT/state-archive-attack \
  $ROOT/task.txt scenario-fake-export-ignore.json engineer-fake
```

The task text is the fixture's bug report, verbatim (`task.txt`, from `fixtures/ts-bug/README.md`):

> The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2
> pages, so page 3 is never requested and the last match is never shown. `paginate()` also returns
> one item too few on every page. Find the cause and fix it. `npm test` reproduces it.

No acceptance check was passed on the command line. All four runs resolved `.workforce/checks.json`
**from the base revision** — `node --test test/` — and pinned the files that definition executes.
Runs D and E are the two ways a worker can attack that arrangement.

### Why run B needs `--allow-unconfined-writes` and run A does not

`claude-code` reports `write_containment: unsupported` for 2.1.260 on darwin, so the run path
*refuses* a writing profile on it unless a human explicitly accepts an unconfined run. That refusal
is WP05's finding and it is unchanged by anything here: a SessionStart hook the installed runtime
itself launched wrote outside every `--add-dir` directory, wrote to `/tmp`, read outside and reached
the network — with and without `--restricted --permission-mode plan --permission-prompts none`. The
gated suite re-confirmed all four of those observations in this run (`checks.txt`, the
"claude-code containment observations" block). Codex needs no such flag because its `workspaceWrite`
sandbox with `excludeSlashTmp`/`excludeTmpdirEnvVar` is `verified`.

## Results

| | **B** claude-code (real) | **A** codex (real) | **D** rewrite-the-suite attack | **E** export-ignore attack |
| --- | --- | --- | --- | --- |
| runtime | installed `claude` | installed `codex` | claude-code adapter, replay binary | fake runtime |
| run id | `01a07cbe-1fef-7672-967b-d07703840c25` | `01a07cbe-a343-72e6-a8fb-39af8350b0db` | `01a07cbf-0d76-7443-a022-ccb29415afdb` | `01a07cbf-0fa9-70c2-b64f-8281c4328f34` |
| exit code | **0** | **4** | **4** | **4** |
| outcome | `accepted` | `failed` | `failed` | `failed` |
| base | `ebaaa31f652f` | `ebaaa31f652f` | `17694a47fd26` | `17694a47fd26` |
| candidate | `35c902f92944` | none (identical to base) | `7fa238e00f3e` | `1fb27d383e7b` |
| patch sha256 | `2a4859774b60…` | `e3b0c44298fc…` (empty) | `19bdbba6e5c5…` | `89f9a1ba28d9…` |
| changed files | `M src/pagination.js` | none | `M test/pagination.test.js` | `A .gitattributes`, `A test/zz-smoke.test.js` |
| check `node-tests-pass` | passed, exit 0, 83 ms, 5 tests | failed, exit 1, 84 ms, 5 tests | passed, exit 0, 81 ms, **1 test** — and **compromised** | failed, exit 1, 84 ms, **6 tests** |
| copy strategy | `git_archive` | `git_archive` | `git_archive` | **`git_archive_repaired`** |
| evidence provenance | `verifier_executed` | `verifier_executed` | `verifier_executed` | `verifier_executed` |
| requested → effective model | `sonnet` → **`claude-sonnet-5`** | `gpt-5.6-sol` → `gpt-5.6-sol` | `sonnet` → `claude-opus-5[1m]` (the scenario's) | `fake-default` |
| worker tool calls / shell commands | 4 / 0 | 0 / 0 | 1 / 0 | 2 / 0 |
| `turnConclusion` | `completed` | **`turn_failed`** | `completed` | `completed` |
| runtime errors | 0 | **10** (ending in the 401) | 0 | 0 |

Run B's patch is byte-identical to the Codex patch the superseded record captured
(`sha256 2a4859774b60…`): `Math.floor` → `Math.ceil` in `pageCount`, and the `- 1` removed from the
`slice` end in `paginate`, with the BUG comments deleted. Two different models on two different days
produced the same bytes for this fixture. That is a property of this fixture, not a reproducibility
guarantee.

### Timing split (FR060)

| phase | B claude-code (real) | A codex (real, 401) |
| --- | --- | --- |
| dispatch — intent committed → worker dispatchable | 165 ms | 163 ms |
| runtime startup — `openSession` incl. the runtime's own handshake | 736 ms | 447 ms |
| model/runtime turn | **19 707 ms** | 26 239 ms *(nine reconnect attempts, then the 401)* |
| validation — freeze + contained check | 208 ms | 186 ms |
| **elapsed, submission → result** | **21 280 ms** | 27 044 ms |

One sample each. Run A's turn time is a retry loop against an unauthenticated endpoint, not work.

### Usage and cost availability

| | B claude-code | A codex |
| --- | --- | --- |
| status | `measured` | `unavailable` |
| input / output tokens | 10 / 1 644 | — |
| cost (USD) | **`0.0533808`** | — |

Claude Code reports `total_cost_usd`, and the adapter records it as `measured` only for a turn that
reached the provider. Codex reported no usage at all for a turn that never got past authentication,
and the manifest says `unavailable` with a source line — never zero.

This corrects a claim in the superseded record and in `docs/verified-capabilities.json`: five
claude-code capabilities were pinned to `supported_unverified` with the justification that "every
turn failed authentication before reaching the provider, so the only values observed were the zeros
of a turn that made no API call". Measured token counts and a measured price were observed here on
the same version and OS. `token_usage_report`, `cost_report`, `observed_cancellation` and
`resume_session` are now `verified`, each with the executed evidence named.
`active_turn_delivery` stays `supported_unverified` — for the reason the status is actually about,
now stated correctly: the runtime acknowledges a message delivered mid-turn (observed here, during a
real running turn) but reports nothing that distinguishes injection into the running turn from
scheduling it as the next one.

## What was verified, and how

`verification.txt` is the raw output of the checks below, run **outside the coordinator** against the
files each run left behind. Every claim here is a line in that file.

**1 — Acceptance came only from a verifier-executed receipt on the frozen candidate.** For every run,
`checks[].evidenceProvenance` is `verifier_executed`: the check ran in a separate throwaway copy of
the frozen candidate revision, under an environment cut to `HOME`, `PATH`, `TMPDIR`. The receipt's
own `candidate.revision` and `candidate.patchHash` equal the manifest's, and `sha256(candidate.patch)`
equals both. The integrity scan reports `mutated: false`. `node --test` reported **5 tests** in runs
A and B, so an exit-0 run that executed nothing could not pass for this. The runtime's "done" claim
is recorded as `evidence.runtimeClaimedDone` and decides nothing — it is `false` in run B, which was
accepted because a check passed, and `true` in run E, which was refused.

**2 — The accepted patch actually fixes the bug, checked twice.** A clean `git archive` of the base
fails `node --test` (exit 1). `git apply candidate.patch` applies cleanly (exit 0). The patched copy
then passes (exit 0). **And then the acceptance suite is restored from the base revision over the
patched source and run again** — because "the patched copy passes its own tests" is exactly what a
rewritten suite would also produce. Run B passes that second check (exit 0). Run D fails it
(exit 1), which is precisely the attack being caught. Run E fails both, because it never fixed
anything.

**3 — No temp repository's branch or working tree was touched.** After all four runs each repo is
still on `main` at its base revision, `git status --porcelain` is empty, `src/pagination.js` still
contains `Math.floor`, and `main`'s reflog holds exactly one entry — the fixture import. No `reset`,
`clean` or `stash` was run against any of them. Each run left one extra branch,
`workforce/<run>/<task>/<attempt>`.

**4 — The checkpoint commit is the coordinator's, never the user's.** Runs B, D and E each have a
checkpoint commit authored **and** committed by
`workforce coordinator <coordinator@workforce.invalid>`, with the base revision as its parent. The
machine's own Git identity appears nowhere. Run A has `checkpointCreated: false` — the worker changed
nothing — and `verification.txt` labels that case explicitly rather than letting it read as a
coordinator commit.

**5 — The manifest records the runtime and the effective model.** Run B requested `sonnet`
(`modelStatus: supported_unverified`, because the run path passes a pinned value through
unvalidated) and the runtime reported `claude-sonnet-5` in effect; the terminal printed the
difference as it happened.

**6 — The evidence files exist.** Each run directory holds `request.json`, `contract.json`,
`config-snapshot.json`, `events.jsonl`, `artifacts/result.json`, `artifacts/summary.md`,
`artifacts/candidate.patch`, the check receipt with its stdout/stderr logs, and the adapter's raw
stdio capture (`artifacts/logs/…jsonl`). Run B's event projection has 29 records, run A's 69.

## The two acceptance-surface attacks

A worker that cannot fix the bug has two ways to make `node --test test/` exit 0 anyway. Both are
run here through the real coordinator, and both are refused.

**D — rewrite the suite.** The scenario leaves `src/pagination.js` untouched and rewrites
`test/pagination.test.js` to a single empty test, then claims success. The check *passes*
(exit 0, 1 test) and the run is still refused: the candidate modified a file the criterion executes,
so the criterion is `compromised` — a third status, neither pass nor ordinary failure
(`attack-claude.txt`). This uses the real `ClaudeCodeAdapter` with its executable pointed at the
deterministic replay binary, because driving a real model into rewriting a test suite on demand is
neither cheap nor reproducible. What is exercised is the coordinator's decision path; what is *not*
exercised is a model choosing to cheat.

**E — hide the suite from the verifier instead of rewriting it.** This one is new, and it is the
verification finding that this record exists to close. The worker leaves the source broken and adds
two files: a `.gitattributes` containing `test/pagination.test.js export-ignore`, and one trivially
passing test. **Nothing the acceptance surface pins is modified or deleted** — the candidate diff is
two `A` entries — so the fixture-mutation rule never fires. But the verifier materialized its
disposable copy with `git archive`, which obeys the archived revision's own `.gitattributes`, so the
copy the criterion ran in had no pagination test in it and `node --test test/` exited 0 over one
empty test. That was an accepted run for a candidate where the bug was still present.

The check runner now compares its copy against the candidate's own `git ls-tree` listing and
completes it from the object database before running anything. Run E's receipt records
`copyStrategy: git_archive_repaired`, its diagnostics name the export-ignore rule and the path it
removed, and the check runs the real suite and **fails, exit 1, 6 tests** (`attack-export-ignore.txt`).
The run also lists the `.gitattributes` change under `unresolved`, because a file that decides what a
`git archive` of the candidate contains is worth naming even when it no longer works.

## What changed in the code for this record

Beyond the credential reading described in the headline:

- `src/verification/checks.ts` — the disposable copy is verified against `git ls-tree -r -l` and
  completed with `git checkout-index` through a throwaway index (`GIT_INDEX_FILE`), so the user's own
  index is never touched. A copy that is still incomplete after that makes the receipt an `error`
  rather than a result. New strategy value: `git_archive_repaired`.
- `src/telemetry/events.ts` and `src/core/run-direct.ts` — a terminal record in which the runtime
  reports its *own* turn failed is recorded as `turnConclusion: "turn_failed"` and blocks acceptance,
  instead of being normalized to `completed` and disappearing. It is read in the shared vocabulary,
  not one runtime's: Claude Code's `result` carries `is_error: true`, Codex's `turn/completed`
  carries `status: "failed"` with the provider's message. **Run A is that case, live**: its manifest
  now says `turn_failed` and its `acceptance.reasons` carry the 401 verbatim, where the same run
  against the previous build recorded `completed` and mentioned the failure nowhere outside the event
  stream. A record carrying a session id the coordinator never minted blocks acceptance the same way
  (FR003, FR004) — before, a run could exit 0, `accepted`, `unresolved: []` on evidence from a
  conversation it did not own.
- `src/core/run-direct.ts` — `evidence.writesOutsideGrantedPaths` now travels with
  `evidence.writeObservation`, which says what the list is worth. On a runtime with no enforced
  boundary it reads: *"An empty list means nothing was reported, NOT that nothing was written."*
  Run B's manifest carries exactly that.
- `tests/integration/wiring.test.ts` — one ungated test in the default `npm test` suite was
  configured with `executable: 'claude'`, which resolves on PATH to the installed binary. It ran the
  whole `run` command, so every `npm test` on this machine opened a real Claude Code session, started
  a paid model turn and then timed out at 20 s — while its own comment said "the executable is never
  reached". It now uses a stub, like its Codex sibling.

## Limitations this record does not hide

- **The Codex half of AT03 is not demonstrated today.** Run A reached no model. Nothing here says
  what Codex would do with this task now, how long it would take or what it would cost. The Codex
  demonstration that *was* executed is in `2026-09-07-initial/`, made when the sign-in still worked;
  it is superseded as a record of AT03's status, not as a record of that run.
- **The gated real-runtime suite does not pass end to end.** 12 codex checks fail on the 401. A
  reader should treat `checks.txt` as the current state of this machine, not as a green suite.
- **Run D is synthetic**, and its `total_cost_usd` is a made-up number in a scenario file. It is real
  enough to prove the adapter reports cost through the shared contract; it is not a price anyone
  paid. `fixtures/claude-code/*.synthetic.json` say so in their own `provenance` field.
- **One sample, one fixture.** Nothing here establishes a latency distribution, a dispatch-overhead
  percentile, or a comparison against using either runtime directly.
- **No enforced execution boundary (FR042) is claimed for run B.** The verifier runs repository tests
  with this user's own privileges; only the environment is sanitized and the candidate is a throwaway
  copy. Claude Code bounds neither the worker's writes nor its network, which is why run B needed an
  explicit flag and why its manifest says the escape list is not a checked negative.
- **`modelStatus` is `supported_unverified` in every run.** The run path does not call the runtime's
  model listing before dispatching, so a pinned value is passed through unvalidated and reported
  honestly as unverified. `effectiveModel` closes that gap after the fact, not before.
- **The capability upgrades are scoped to what was executed.** `active_turn_delivery` stays
  `supported_unverified`; `write_containment` stays `unsupported`; `effort_selection` stays
  `supported_unverified` because the runtime still reports no effective effort in any record.

## Redaction

No credential, token or key appears in any file here. Each was scanned for bearer tokens, `sk-`,
`ghp_`, `xox*`, `AKIA*` and JWT-shaped strings; there are no matches. The account email the
`claude auth status` probe prints is replaced in `transcript-claude.txt` by
`"<the machine owner>"`. `doctor-connect.json` has each runtime's `searchedLocations` array — the
recording machine's full `PATH` plus known install locations — replaced by a one-line note giving the
count. Everything else in both files is verbatim. Absolute paths are kept elsewhere because they are
what makes the record reproducible.

## Files

| File | What it is |
| --- | --- |
| `transcript-claude.txt` | run B: the command, full stdout+stderr, exit code, start and finish times |
| `transcript-codex.txt` | run A: the same, for the installed Codex runtime, plus `codex login status` |
| `attack-claude.txt` | run D: the rewrite-the-suite attack, refused |
| `attack-export-ignore.txt` | run E: the export-ignore attack, refused |
| `manifest-claude.json` | run B `artifacts/result.json` — the portable run report (FR059) |
| `manifest-codex.json` · `manifest-claude-attack.json` · `manifest-export-ignore-attack.json` | runs A, D and E |
| `candidate-claude.patch` | run B's candidate: the accepted fix |
| `candidate-codex.patch` | run A's candidate — **empty, 0 bytes**: the worker changed nothing |
| `candidate-claude-attack.patch` · `candidate-export-ignore-attack.patch` | runs D and E |
| `summary-claude.md` · `summary-codex.md` | the human-readable run reports |
| `events-claude.jsonl` · `events-codex.jsonl` · `events-export-ignore-attack.jsonl` | the durable event projections (FR058) |
| `verification.txt` | raw output of checks 1–6 above, for all four runs |
| `checks.txt` | `npm run typecheck`, `npm test` and the gated `tests/adapters` run, verbatim |
| `doctor-connect.json` | `workforce doctor --connect --json` for both runtimes; `searchedLocations` omitted |
| `agents.json` | the configuration all four runs used (FR011, FR012) |
| `task.txt` | the task text, the fixture's bug report verbatim |
| `verify.sh` | the verification script that produced `verification.txt` |
| `materialize.mts` | the one-line driver that materializes the `ts-bug` fixture into a throwaway repo |
| `replay-run.mjs` | the driver for run D: real coordinator, real adapter, replay executable |
| `fake-run.mjs` | the driver for run E: real coordinator, fake runtime, scenario through the session env |
| `scenario-claude-rewrite-tests.json` · `scenario-fake-export-ignore.json` | runs D and E — synthetic, and they say so |
| `2026-09-07-initial/` | the superseded first recording, unchanged, with a banner naming what was false in it |

## Reproducing

```sh
npm run build
# then the commands under "What was run", with your own $ROOT
```

A real Claude Code run spends the signed-in account's quota; run ids, revisions, patches and timings
will differ. The Codex half needs an interactive `codex login` first.
