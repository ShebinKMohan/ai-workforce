# workforce

A local terminal coordinator. You describe an engineering task once; it dispatches the coding
runtimes already installed on your machine (Codex, Claude Code) into isolated candidate Git
worktrees, coordinates them, and then **verifies the result with checks it executes itself**
against a frozen candidate.

Nothing here is a cloud service. There is no API key to set: it drives the CLIs you already have
and the logins they already hold, and it never modifies your checkout.

## Start here

```
workforce
```

That is the whole command. On a terminal it asks — in plain language — only for what it cannot
work out for itself, and says out loud everything it worked out:

| it asks | only when |
| --- | --- |
| which repository | the working directory is not a Git repository with a commit |
| which agent | more than one configured agent could take the work |
| may it write an agent configuration | none was found in any of the usual places |
| which acceptance check | the resolved checks were rejected, or there were none |
| may writes go unconfined | the chosen runtime enforces no write boundary |
| what the task is | neither `--task` nor `--task-file` was given |

Along the way it will tell you:

- **the repository, the base revision and whether your tree is dirty** — the run works from the
  committed base, and your checkout is never touched;
- **which runtimes are installed, and which are signed out** — with the exact login command for
  the ones that are (`codex login`, `claude auth login`). This discovery is passive: `--version`
  and the documented login-status command, and never a model turn;
- **which acceptance checks it resolved, and from where** — before it runs anything, because a
  check the verifier executes is the only thing that can accept a candidate;
- **the equivalent flag form** — the one-line `workforce run …` that would have started the same
  run, so the second time you can skip the questions.

The launcher needs a terminal. In a pipe, a script or CI, name the run with flags instead — the
bare invocation says so and prints the usage.

## Every flag still works

The interactive session is an additional front door, not a replacement. It assembles exactly the
same call:

```
workforce run --repo . --agents ~/.workforce/agents.json \
  --task "Fix the pagination off-by-one" \
  --check "npm test" --allow-unconfined-writes
```

| command | what it does |
| --- | --- |
| `workforce` | the interactive launcher above |
| `workforce doctor [--connect]` | read-only runtime discovery and readiness. `--connect` runs each runtime's own control handshake — a process, never a model turn — and is the only way to reach `verified_ready` |
| `workforce run …` | start a run with explicit configuration |
| `workforce status <run-id>` | inspect persisted state, read-only, while a run is in progress |
| `workforce watch <run-id> [--task <key>]` | attach to one task's stream in another terminal |
| `workforce resume <run-id>` | reconcile an interrupted run and continue it under exclusive ownership |

Run `workforce --help` for every flag.

### Seeing what each agent is doing

A planned run of two or more tasks draws a live board on a real terminal: one row per dispatched
task, a focus pane for the task you select, and the complete attributed transcript replayed into
your scrollback when it exits. `--view live|plain` forces or refuses it; `--json`, a pipe, a
redirect, `TERM=dumb` and a terminal smaller than 60x12 always take the plain renderer, whose
output is byte-for-byte what it always was. `--watch` prints a ready-to-paste
`workforce watch <run-id> --task <key>` line per task, for a run you would rather follow in
separate terminals.

## Configuration

An agent configuration is one JSON document (`schemaVersion: 1`) binding named roles to installed
runtimes. `fixtures/agents/example.json` is a working example. If you have none, the launcher
offers to write one for the runtimes it actually found, into the coordinator's state root
(`~/.workforce/agents.json` by default) — never into your repository. It is looked for, in order,
in `--agents`, `$WORKFORCE_AGENTS`, the state root, `<repo>/.workforce/agents.json`, and
`~/.workforce/agents.json`.

Acceptance checks come from `--check "<command> [args]"`, then from `.workforce/checks.json` **at
the base revision**, then from detection of the project's own test setup. Checks are executed with
an argument array and never through a shell, in a disposable copy of the frozen candidate, and the
tracked files are hashed on both sides of the run: a candidate that rewrites its own acceptance
suite is recorded as compromised evidence, not as a pass.

## What a run promises

- A runtime saying "done" never accepts anything. Only checks the verifier executed against a
  frozen candidate do.
- Your checkout is never reset, cleaned, stashed or committed to. Work happens in a candidate
  worktree; the result is a local candidate plus its evidence.
- Coordinator state lives outside worker write access, under `~/.workforce` (or `--state-dir`).
- Exit codes are frozen: `0` verified candidate, `2` invalid input or configuration, `3` a
  required user action, `4` execution or validation failure, `130` interrupted.
- `--json` keeps stdout machine-readable: exactly JSONL for `run` (one event object per line, the
  final result object last), and every human line on stderr.

## Development

```
npm test          # vitest
npm run typecheck # tsc, strict
```

`docs/plan.md` is the authoritative specification; `AGENTS.md` holds the repository conventions.
