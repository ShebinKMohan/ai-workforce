# R0 evidence — one installed runtime fixes an isolated repository bug, verified

Release gate: **R0 — first working demonstration** (plan §3) · Acceptance test: **AT02** ·
Work package: **WP04 — one verified change** · Features exercised: **FR001, FR002, FR011, FR014,
FR019, FR020, FR039, FR041, FR049, FR050, FR058, FR059, FR060, FR061, FR065, FR066**

Recorded 7 September 2026 on the author's macOS machine, re-recorded after the independent
verification of the first R0 record. Everything below was executed; where a statement is not
backed by an executed command it says so.

The first recording is kept unchanged in [`2026-09-07-initial/`](2026-09-07-initial/). It is
superseded because one of its claims was false — see [What changed since the first
recording](#what-changed-since-the-first-recording).

## Source revision that produced this evidence

These runs used `dist/` built by `npm run build` from the working tree that the commit adding
this directory records (`Address R0 verification findings`, parent `bbc5baa`). Nothing under `src/`
or `fixtures/` changed between that build and this record; `npm run typecheck` and `npm test` were
run against the same tree.

## Environment

| Fact | Value |
| --- | --- |
| Runtime under test | `codex-cli 0.147.0` at `/opt/homebrew/bin/codex`, ChatGPT sign-in |
| Model / effort pinned by the agent config | `gpt-5.6-sol` / `medium` |
| Node | v26.8.1 · Git 2.50.1 · darwin 25.6.0, arm64 |
| Also discovered, not used for the run | `claude 2.1.260` at `~/.local/bin/claude` (adapter arrives with WP05) |

The model is pinned deliberately. This machine's `~/.codex/config.toml` defaults to `gpt-6-astra`,
which `codex-cli 0.147.0` rejects with HTTP 400 (`docs/runtime-codex.md` §6.2). A run should pin a
model from the table `model/list` reports rather than inherit the user's default.

## What was run

The fixture is materialized into a throwaway Git repository first, because a run creates branches
and worktrees and the verifier executes repository code. `fixtures/ts-bug` itself is never touched.

```sh
TMP=$(mktemp -d)

cat > /tmp/materialize.mts <<'EOF'
import { materializeFixture } from '<this repo>/fixtures/materialize.js';
const f = await materializeFixture('ts-bug', { targetDir: process.argv[2] });
console.log(JSON.stringify({ path: f.path, branch: f.branch, headRevision: f.headRevision }, null, 2));
EOF
npx tsx /tmp/materialize.mts "$TMP/repo"     # → base e4a85d0e913f… on branch main

( cd $TMP/repo && node --test test/ )        # → exit 1: the bug reproduces

node dist/cli/index.js run \
  --repo      $TMP/repo \
  --agents    $TMP/agents.json \
  --state-dir $TMP/state-human \
  --task "$(cat $TMP/task.txt)"                                    # → exit 0   transcript.txt

node dist/cli/index.js run \
  --repo      $TMP/repo \
  --agents    $TMP/agents.json \
  --state-dir $TMP/state-json \
  --task "$(cat $TMP/task.txt)" --json                             # → exit 0   run-json.jsonl

node dist/cli/index.js status 01a07b5b-4396-756d-a4fb-db615900d7fc \
  --state-dir $TMP/state-human                                     # → exit 0   status.txt

node dist/cli/index.js doctor --json --agents $TMP/agents.json \
  --state-dir $TMP/state-doctor                                    # → exit 0   doctor.json
```

The task text is the fixture's bug report, verbatim (`fixtures/ts-bug/README.md`):

> The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2
> pages, so page 3 is never requested and the last match is never shown. `paginate()` also returns
> one item too few on every page. Find the cause and fix it. `npm test` reproduces it.

No acceptance check was passed on the command line. Both runs resolved `.workforce/checks.json`
**from the base revision** — `node --test test/` — so the worker could not edit the check
*definition*. The code that definition executes lives in the repository, so the run also pins the
files the criterion runs (`.workforce/checks.json`, `test/`, `test/pagination.test.js`), tells the
worker not to change them, and refuses acceptance if the candidate did. In these two runs it did
not: the only changed file is `src/pagination.js`.

The agent configuration is `agents.json` in this directory: one runtime (`codex-local`) and one
agent (`engineer`, policy `local-development`) as the default worker.

## Results

| | run A (human) | run B (`--json`) |
| --- | --- | --- |
| run id | `01a07b5b-4396-756d-a4fb-db615900d7fc` | `01a07b5c-bc7e-7242-89cd-f5fe6ce66166` |
| exit code | 0 | 0 |
| outcome | `accepted` (task `accepted`, run `ready_for_review`) | `accepted` |
| base revision | `e4a85d0e913fa1eca304777f689b946b2d7f64c1` | same |
| candidate revision | `06f564ceabe888995b58b1ffc2c3e07187e8a50f` | `bb295d4b60b7f3aba17c7ac5df2cb1653fb0e3b6` |
| candidate patch sha256 | `2a4859774b60…e7b4` | identical |
| changed files | `M src/pagination.js` | `M src/pagination.js` |
| check | `node-tests-pass` → exit 0 in 80 ms, 5 tests, `verifier_executed` | exit 0 in 81 ms, 5 tests, `verifier_executed` |
| acceptance fixtures changed | none | none |
| worker shell commands | 8 | 8 |
| unresolved | none | none |

Both runs produced a byte-identical patch: `Math.floor` → `Math.ceil` in `pageCount`, and the
removal of the `- 1` from the `slice` end in `paginate`. That is a property of this fixture, not a
reproducibility guarantee — an earlier pair of runs on the same fixture and configuration agreed on
the code and differed in the doc comments. Both patches were applied to a clean copy of the base and
both turn a failing suite into a passing one (`verification.txt` V3).

### Timing split (FR060)

| phase | run A | run B |
| --- | --- | --- |
| dispatch (intent committed → worker dispatchable) | 174 ms | 210 ms |
| runtime startup (`openSession`, incl. the user's MCP servers) | 1 594 ms | 1 250 ms |
| model/runtime turn | 93 284 ms | 113 448 ms |
| validation (freeze + contained check) | 217 ms | 222 ms |
| **elapsed, submission → accepted** | **96 309 ms** | **116 163 ms** |

Two samples, warm, one machine. These are observations, not a performance claim; the plan's
dispatch-overhead target is not evaluated here.

Usage is **measured** in tokens (run A: 303 081 in / 1 919 out) and **cost is `null`** — the app
server reports no currency figure, so cost is unavailable, never zero.

## What was verified, and how

`verification.txt` is the raw output of the checks below; every number here comes from it.

**1. The task reached `accepted` only because a verifier-executed check passed on the frozen
candidate.** The single required criterion carries `evidenceProvenance: "verifier_executed"`. It ran
in a separate `git_archive` copy of candidate `06f564ce…`, under an environment cut down to `HOME`,
`PATH`, `TMPDIR`, and the integrity scan over all 6 tracked files reported `mutated: false` before
and after. The runner's own summary is recorded too — `node --test` reported **5 tests**, so an
exit-0 run that executed nothing could not be mistaken for this. The runtime's `claimsDone` is
recorded as `evidence.runtimeClaimedDone: true` and is not what decided acceptance.

**2. The candidate could not have manufactured its own pass.** The criterion's fixtures at the base
revision are recorded in `evidence.acceptanceFixturePaths`, listed in the task contract's
`forbiddenPaths`, and compared against the candidate diff: `acceptanceFixtureMutations` is empty for
both runs. `acceptance-integrity.txt` shows the refusals that fire when it is not — including the
exact "rewrite the tests" attack that the first recording of this evidence would have accepted.

**3. Both candidate patches fix the bug.** Checked outside the coordinator: a clean `git archive` of
the base fails `node --test` (exit 1); `git apply candidate.patch` applies cleanly; the same copy
then passes (exit 0). Done for run A and run B separately.

**4. The user's checkout was never touched.** After both runs, `$TMP/repo` is still on `main` at
`e4a85d0e…`, `git status --porcelain` is empty, `src/pagination.js` still contains the bug, and
`main`'s reflog holds exactly one entry — the fixture import. No `reset`, `clean` or `stash` was run
against it.

**5. Each run left a candidate branch with a coordinator checkpoint commit.** Both branches are
named `workforce/<run>/<task>/<attempt>`, both have the base as their parent, and both checkpoint
commits are authored `workforce coordinator <coordinator@workforce.invalid>` — never the user's Git
identity.

**6. Patch bytes hash to the recorded candidate identity.** `sha256(candidate.patch)` equals the
manifest's `candidate.patchHash` and the `patchHash` inside the check receipt, and the receipt's
`candidate.revision` equals the manifest's `candidate.revision`.

**7. The evidence files exist.** For run A: `events.jsonl` (127 records), `request.json`,
`contract.json`, `config-snapshot.json`, `artifacts/result.json`, `artifacts/summary.md`,
`artifacts/candidate.patch`, `artifacts/logs/runtime-events.jsonl` and the check receipt with its
stdout/stderr logs.

**8. `--json` keeps stdout machine-readable.** All 119 stdout lines parse as JSON — the normalized
events as JSONL, then the final result object. The human progress lines went to stderr (72 lines,
kept here as `run-json.stderr.txt`).

**9. `doctor` started no model turn.** It spawned exactly four processes: `--version` and the
documented login-status command for each of the two discovered runtimes. Their argv and exit codes
are in `doctor.json`. The configured runtime's `executable` is the same file discovery selected, so
no extra probe was needed; when a configuration pins a *different* path, doctor probes that binary
and reports its version and capabilities rather than the discovered one's.

## What changed since the first recording

An independent verification of `2026-09-07-initial/` found ten defects. The two that made this
record's headline claim untrue:

- the first README said "nothing the worker did to the repository could change what acceptance
  means". That was false. The check *command* came from the base revision, but the test *code* it
  executes came from the candidate, so a worker that rewrote `test/` was accepted with
  `verifier_executed` evidence while the bug remained. It is now refused; `acceptance-integrity.txt`
  A1 and A2 are the reproductions.
- a run was accepted with exit 0 when the worker wrote outside its granted paths, when the runtime
  died mid-turn, and when the worker changed nothing at all. Those are `acceptance-integrity.txt`
  A3, A4 and A5, and each is now a refusal with the reason in `acceptance.reasons`.

Also fixed and evidenced here: Ctrl+C against an unresponsive runtime used to hang the coordinator
indefinitely (A6), and deleting the lock arbiter let a second mutating coordinator into the same
state root (A7). `runTimeoutMinutes` is now a real deadline rather than a number in the manifest.

## Limitations this run does not hide

- **The acceptance-fixture rule is a decision, not a boundary.** The run refuses evidence whose
  fixtures the candidate changed; it does not stop the worker from changing them. Nothing stops a
  worker from adding a *new* test file either — additions are recorded (`acceptanceFixtureAdditions`)
  and deliberately do not block, because writing a test to protect a fix is legitimate work. The
  zero-test check only recognizes `node --test` and `python -m unittest`; for any other runner the
  exit status is still the only evidence of what it executed.
- **The verifier runs repository tests with this user's own privileges.** Only the environment is
  sanitized — no coordinator credentials, no variable whose name matches the redaction rule — and the
  candidate is a throwaway copy. There is no OS-level containment, so a repository test can read and
  write anything this user can, including the coordinator state root. That boundary is FR042, an R1
  gate, and the manifest's `evidence.containmentNote` says so.
- **The sandbox bounds writes and network, not reads.** `sandbox-boundary.txt` (recorded with the
  first evidence set and unchanged) applies the exact `local-development` policy a turn gets: a write
  inside the granted root succeeds, a write outside it fails with `Operation not permitted`, `curl`
  cannot resolve a host — and **a read of a file outside the granted root succeeds**.
  `docs/runtime-codex.md` §6.10 records it.
- **A worktree is development isolation, not a security sandbox.** The enforced execution boundary
  for tool and test subprocesses (FR042) is an R1 gate and is not claimed by these runs.
- **One adapter, one worker, no coordination.** No planner, reviewer, peer message, handoff, repair
  loop or resume is demonstrated here. Those are R1 (AT03–AT15).
- **Two samples.** Nothing here establishes a latency distribution or a comparison against using
  Codex directly.
- **`modelStatus` / `effortStatus` are `supported_unverified`.** The run path does not call
  `model/list` before dispatching, so the pinned values are passed through and reported honestly as
  unverified rather than being claimed as validated.
- **The user's configured MCP servers start with every Codex thread.** They account for most of the
  ~1.3–1.6 s startup and for most of the 87–91 unnormalized runtime events; the adapter cannot
  suppress them on this version (`docs/runtime-codex.md` §6.3).
- **`acceptance-integrity.txt` uses the fake runtime, not Codex.** Steering a real model into each
  of those seven failure shapes is neither cheap nor reproducible; the scenarios exercise the
  coordinator's own decision path, which is what changed.

## Redaction

No credential, token or key appears in any file here; each was scanned for bearer tokens, `sk-`,
`ghp_`, `xox*`, `AKIA*` and JWT-shaped strings. The only match is the literal string
`--ask-for-approval` inside `doctor.json`.

`doctor.json` is the one edited file: each runtime's `searchedLocations` array — the recording
machine's full `PATH` plus known install locations, naming unrelated local tooling and per-session
directories — was replaced with a one-line note giving the count. Everything else in it is verbatim.
Absolute paths are kept elsewhere, because they are what makes the report reproducible: the two
runtime executables, this repository, and the throwaway `$TMP` root the runs used (a per-session
scratch directory that no longer exists). `acceptance-integrity.txt` abbreviates its own scratch root
to `$T` only because those lines are long, not because it is sensitive.

## Files

| File | What it is |
| --- | --- |
| `transcript.txt` | run A: the command, its full stdout, its stderr and its exit code |
| `run-json.jsonl` | run B: complete `--json` stdout (JSONL events, then the result object) |
| `run-json.stderr.txt` | run B: the human diagnostics `--json` sends to stderr |
| `manifest.json` | run A `artifacts/result.json` — the portable run report (FR059) |
| `summary.md` | run A `artifacts/summary.md` — the same thing for a human |
| `candidate.patch` | run A's candidate |
| `events.jsonl` | run A's durable event projection, 127 records (FR058) |
| `status.txt` | `workforce status <run-id>` — read-only inspection (FR061) |
| `doctor.json` | `workforce doctor --json` (FR001, FR002), `searchedLocations` omitted |
| `agents.json` | the agent configuration both runs used (FR011) |
| `sandbox-boundary.txt` | `command/exec` probe of the `local-development` boundary; no model turn |
| `verification.txt` | raw output of checks 1–9 above |
| `acceptance-integrity.txt` | the seven refusals, run against the fake runtime (FR039, FR049, FR050) |
| `2026-09-07-initial/` | the superseded first recording, unchanged apart from a pointer at its top |

## Reproducing

```sh
npm run build
# then the commands under "What was run", with your own $TMP
```

`npm run typecheck` and `npm test` were green when this was recorded (245 passed, 11 skipped — the
skips are the real-runtime checks behind `WORKFORCE_REAL_RUNTIMES=1`). A real run spends ChatGPT
quota; run ids, revisions, patches and timings will differ.
