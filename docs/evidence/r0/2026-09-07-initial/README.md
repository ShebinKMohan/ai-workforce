> **Superseded — kept for the record, not as a current claim.** Independent verification of this
> record found that its central claim below, "nothing the worker did to the repository could change
> what acceptance means", was false: the check *command* was read from the base revision, but the
> test *code* that command executes came from the candidate, so a worker that rewrote `test/` was
> accepted with verifier-executed evidence while the bug remained. The runs recorded here are
> unaffected — their patch really does fix the bug — but the guarantee stated was not the one the
> code provided. Nothing else in this file has been edited. See `../README.md` for the current R0
> record and `../acceptance-integrity.txt` for the reproductions.

# R0 evidence — one installed runtime fixes an isolated repository bug, verified

Release gate: **R0 — first working demonstration** (plan §3) · Acceptance test: **AT02** ·
Work package: **WP04 — one verified change** · Features exercised: **FR001, FR002, FR011, FR019,
FR020, FR041, FR049, FR050, FR058, FR059, FR060, FR061, FR065, FR066**

Recorded 7 September 2026 on the author's macOS machine. Everything below was executed; where a
statement is not backed by an executed command it says so.

## Source revision that produced this evidence

```
7807aded5e4aadf08481ec1a7ae105c5a0f9f376   WP04: say that the runtime sandbox bounds writes, not reads (FR042, FR059)
```

`npm run build` was run from that tree and every command below invoked `dist/cli/index.js` from that
build. The commit that adds this directory also edits `docs/runtime-codex.md` §6 to point at
`sandbox-boundary.txt`; nothing under `src/` changed after `7807ade`.

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
TMP=$(mktemp -d)                            # actually /…/T/workforce-r0

cat > /tmp/materialize.mts <<'EOF'
import { materializeFixture } from '<this repo>/fixtures/materialize.js';
const f = await materializeFixture('ts-bug', { targetDir: process.argv[2] });
console.log(JSON.stringify({ path: f.path, branch: f.branch, headRevision: f.headRevision }, null, 2));
EOF
npx tsx /tmp/materialize.mts "$TMP/repo"     # → base 7b7e317aa85b… on branch main

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

node dist/cli/index.js status 01a07ade-6f69-7166-89b2-650940cddd7a \
  --state-dir $TMP/state-human                                     # → exit 0   status.txt

node dist/cli/index.js doctor --json --agents $TMP/agents.json \
  --state-dir $TMP/state-doctor                                    # → exit 0   doctor.json
```

The task text is the fixture's bug report, verbatim (`fixtures/ts-bug/README.md`):

> The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2
> pages, so page 3 is never requested and the last match is never shown. `paginate()` also returns
> one item too few on every page. Find the cause and fix it. `npm test` reproduces it.

No acceptance check was passed on the command line. Both runs resolved
`.workforce/checks.json` **from the base revision** — `node --test test/` — so nothing the worker
did to the repository could change what acceptance means.

The agent configuration is `agents.json` in this directory: one runtime (`codex-local`) and one
agent (`engineer`, policy `local-development`) as the default worker.

## Results

| | run A (human) | run B (`--json`) |
| --- | --- | --- |
| run id | `01a07ade-6f69-7166-89b2-650940cddd7a` | `01a07adf-c405-77f8-b5b1-681a87300045` |
| exit code | 0 | 0 |
| outcome | `accepted` (task `accepted`, run `ready_for_review`) | `accepted` |
| base revision | `7b7e317aa85b7a3b4a67056991859fdd44953ba5` | same |
| candidate revision | `1b54578be36ff269bd64852c49a56b2ef8edf453` | `05297664593e181ea3916c32af979161e21a0d82` |
| candidate patch sha256 | `2a4859774b600038ab57e399f5192a907daf1a3081d09ca3d0d62546ae00e7b4` | identical |
| changed files | `M src/pagination.js` | `M src/pagination.js` |
| check | `node-tests-pass` → exit 0 in 80 ms, `verifier_executed` | exit 0 in 81 ms, `verifier_executed` |
| worker shell commands | 7 | 5 |
| unresolved | none | none |

Two independent turns produced a byte-identical patch. That is a property of this fixture, not a
reproducibility guarantee.

### Timing split (FR060)

| phase | run A | run B |
| --- | --- | --- |
| dispatch (intent committed → worker dispatchable) | 144 ms | 138 ms |
| runtime startup (`openSession`, incl. the user's MCP servers) | 1 352 ms | 1 218 ms |
| model/runtime turn | 84 293 ms | 70 788 ms |
| validation (freeze + contained check) | 195 ms | 195 ms |
| **elapsed, submission → accepted** | **87 027 ms** | **73 381 ms** |

Two samples, warm, one machine. These are observations, not a performance claim; the plan's
dispatch-overhead target is not evaluated here.

Usage is **measured** in tokens (run A: 227 583 in / 2 312 out) and **cost is `null`** — the app
server reports no currency figure, so cost is unavailable, never zero.

## What was verified, and how

`verification.txt` is the raw output of the checks below; every number here comes from it.

**1. The task reached `accepted` only because a verifier-executed check passed on the frozen
candidate.** The single required criterion carries `evidenceProvenance: "verifier_executed"`. It ran
in a separate `git_archive` copy of candidate `1b54578b…`, under an environment cut down to
`HOME`, `PATH`, `TMPDIR`, and the integrity scan over all 6 tracked files reported `mutated: false`
before and after. The runtime's own `claimsDone` is recorded as `evidence.runtimeClaimedDone: true`
and is not what decided acceptance — the deterministic counterpart is
`tests/run/direct.test.ts`, where a runtime that claims success without editing anything is
reported `failed`.

**2. The candidate patch fixes the bug.** Checked outside the coordinator: a clean `git archive` of
the base fails `node --test` (exit 1); `git apply candidate.patch` applies cleanly; the same copy
then passes (exit 0). The patch is the two off-by-one corrections — `Math.floor` → `Math.ceil` in
`pageCount`, and the removal of the `- 1` from the `slice` end in `paginate`.

**3. The user's checkout was never touched.** After both runs, `$TMP/repo` is still on `main` at
`7b7e317a…`, `git status --porcelain` is empty, `src/pagination.js` still contains the bug, and
`main`'s reflog holds exactly one entry — the fixture import. No `reset`, `clean` or `stash` was run
against it.

**4. Each run left a candidate branch with a coordinator checkpoint commit.** Both branches are
named `workforce/<run>/<task>/<attempt>`, both have the base as their parent, and both checkpoint
commits are authored `workforce coordinator <coordinator@workforce.invalid>` — never the user's Git
identity.

**5. Patch bytes hash to the recorded candidate identity.** `sha256(candidate.patch)` equals the
manifest's `candidate.patchHash` and the `patchHash` inside the check receipt, and the receipt's
`candidate.revision` equals the manifest's `candidate.revision`.

**6. The evidence files exist.** For run A: `events.jsonl` (116 records), `request.json`,
`contract.json`, `config-snapshot.json`, `artifacts/result.json`, `artifacts/summary.md`,
`artifacts/candidate.patch`, `artifacts/logs/runtime-events.jsonl` and the check receipt with its
stdout/stderr logs.

**7. `--json` keeps stdout machine-readable.** All 110 stdout lines parse as JSON — the normalized
events as JSONL, then the final result object. The human progress lines went to stderr (66 lines,
kept here as `run-json.stderr.txt`).

**8. `doctor` started no model turn.** It spawned exactly four processes: `--version` and the
documented login-status command for each of the two discovered runtimes. Their argv and exit codes
are in `doctor.json`.

## Limitations this run does not hide

- **The sandbox bounds writes and network, not reads.** `sandbox-boundary.txt` applies the exact
  `local-development` policy a turn gets: a write inside the granted root succeeds, a write outside
  it fails with `Operation not permitted`, `curl` cannot resolve a host — and **a read of a file
  outside the granted root succeeds**. A rehearsal run of this same demonstration recorded a turn
  reading `~/.codex/memories/MEMORY.md` from inside the candidate worktree; the two transcripts kept
  here happen not to contain that command. `docs/runtime-codex.md` §6.10 records it.
- **A worktree is development isolation, not a security sandbox.** The enforced execution boundary
  for tool and test subprocesses (FR042) is an R1 gate and is not claimed by these runs; the
  manifest says so in `evidence.containmentNote`.
- **One adapter, one worker, no coordination.** No planner, reviewer, peer message, handoff, repair
  loop or cancellation is demonstrated here. Those are R1 (AT03–AT15).
- **Two samples.** Nothing here establishes a latency distribution or a comparison against using
  Codex directly.
- **`modelStatus` / `effortStatus` are `supported_unverified`.** The run path does not call
  `model/list` before dispatching, so the pinned values are passed through and reported honestly as
  unverified rather than being claimed as validated.
- **The user's configured MCP servers start with every Codex thread.** They account for most of the
  ~1.2–1.4 s startup and for most of the 82–83 unnormalized runtime events; the adapter cannot
  suppress them on this version (`docs/runtime-codex.md` §6.3).

## Redaction

No credential, token or key appears in any file here; each was scanned for bearer tokens, `sk-`,
`ghp_`, `xox*`, `AKIA*` and JWT-shaped strings. The only match is the literal string
`--ask-for-approval` inside `doctor.json`.

`doctor.json` is the one edited file: each runtime's `searchedLocations` array — the recording
machine's full `PATH` plus known install locations, naming unrelated local tooling and per-session
directories — was replaced with a one-line note giving the count. Everything else in it is verbatim.
Absolute paths to the two runtime executables and to this repository are kept, because they are what
makes the report reproducible.

## Files

| File | What it is |
| --- | --- |
| `transcript.txt` | run A: the command, its full stdout, its stderr and its exit code |
| `run-json.jsonl` | run B: complete `--json` stdout (JSONL events, then the result object) |
| `run-json.stderr.txt` | run B: the human diagnostics `--json` sends to stderr |
| `manifest.json` | run A `artifacts/result.json` — the portable run report (FR059) |
| `summary.md` | run A `artifacts/summary.md` — the same thing for a human |
| `candidate.patch` | run A's candidate, byte-identical to run B's |
| `events.jsonl` | run A's durable event projection, 116 records (FR058) |
| `status.txt` | `workforce status <run-id>` — read-only inspection (FR061) |
| `doctor.json` | `workforce doctor --json` (FR001, FR002), `searchedLocations` omitted |
| `agents.json` | the agent configuration both runs used (FR011) |
| `sandbox-boundary.txt` | `command/exec` probe of the `local-development` boundary; no model turn |
| `verification.txt` | raw output of checks 1–10 above |

## Reproducing

```sh
npm run build
# then the commands under "What was run", with your own $TMP
```

`npm run typecheck` and `npm test` were green at `7807ade` (223 passed, 11 skipped — the skips are
the real-runtime checks behind `WORKFORCE_REAL_RUNTIMES=1`). A real run spends ChatGPT quota; run
ids, revisions and timings will differ.
