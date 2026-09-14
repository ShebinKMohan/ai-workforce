# AI Workforce

A local workspace for your coding agents. Headquarters, project issues, Control Center,
department heads, workers and verification run from this one repository. The frontend is in
`web/headquarters`, beside the TypeScript backend in `src`. One local server serves both.

## Open the app

Double-click **[Run Workforce.command](Run%20Workforce.command)** on this Mac, or use
**[run.sh](run.sh)** for your usual script workflow. Both launchers prepare the frontend and
backend together, start the local workspace, and open its page. If it is already running,
they open that same workspace. You can close the launcher window while your workforce runs.

The **AI Workforce** app in your Applications folder is also available.
You can also open **[AI Workforce in your browser](http://127.0.0.1:4421/)**.

Choose **Connections** to automatically detect Codex and Claude Code. Click **Connect** for the
agent you use; the app saves and verifies the connection. No copied command or configuration
is required. See [Connect your coding agents](docs/mcp.md) for the short walkthrough.

The source, frontend and backend live together in this repository. Workspace data remains
outside the source checkout. The launcher keeps using this Mac's saved workspace and team.

<details>
<summary>Developer startup and local preferences</summary>

`run.sh` works from any working directory, including paths containing spaces. It finds a supported
local Node installation, installs missing or mismatched project dependencies from the lock file,
and builds the backend and frontend assets before a cold start. Repeated launches reuse the
matching server; simultaneous launches prepare and start it only once. `--no-open` skips opening
the browser. `npm start` still provides the foreground developer workflow.
Node.js 22.13 or newer is required. The macOS launcher source and installer are in `scripts/`.

The ignored `.workforce-local.json` selects the saved state folder and port.
`WORKFORCE_STATE_DIR` and `WORKFORCE_PORT` override it. Without preferences, startup uses
`~/.workforce` and port 4421. Source changes require restarting the backend after its work has
stopped. An existing server is reused only when its source and workspace identities match.

</details>

## Project issues and coding-agent connections

Open **Projects** to register a Git repository and its verification commands. Configure a
department head and project-assigned workers in **Departments** and **Agents**; Control Center
uses those saved runtime bindings to route work. Adding a project does not invent a team.

Open **Issues** for the project's Kanban board: **Backlog**, **To Do**, **In Progress**,
**In Review**, and **Done**. Create a brief, plan or PRD, edit its description, and organize its
column. **Send to Control Center** starts execution through the ordinary durable request queue.
Changing a manual column never launches an agent. Linked issues show actual request progress,
blockers and verification; a manually completed card is not a verified coding result.

Open **Connections** to detect and connect Codex or Claude Code with one click. External coding agents can discover
projects, submit a complete PRD or plan, create and update issues, and explicitly start work.
Stable idempotency keys make retrying an uncertain submission reuse the same issue/request.
See **[Connect your coding agents](docs/mcp.md)** for the simple app workflow.

The workflow is:

```text
Codex / Claude → Workforce MCP → project issue → Control Center
  → department head → assigned workers → independent checks → head review → result
```

MCP is a local stdio connection to the same running server. It does not create a second
scheduler. Saving a plan with `start: false` only records the issue; `start: true` sends it for
execution and can use the configured runtime's model allowance.

## Headquarters and results

Headquarters shows the configured company and actual work. The task rail opens conversations,
recorded output and evidence. New feed submissions are independent requests; followups in an
opened conversation carry that conversation's bounded context. New requests do not cancel
older work. Projects, Departments, Agents, Runtimes, Executions and Settings share this interface.

The earlier evidence workspace remains at `/workspace/`; the older office is at `/office/`.
Those compatibility views use the same backend. The old separate frontend/proxy server is no
longer part of startup. Original frontend files and Git metadata were preserved in the
[consolidation evidence](docs/evidence/consolidation-2026-09-13/README.md).

Open a task to see who is acting now and its five recorded phases:

| Phase | What it means |
| --- | --- |
| **Sent** | Your request was recorded and Control Center selects its route; any queue wait has a reason. |
| **Department head** | The head reads this project and submits a plan for eligible workers. |
| **Work** | Each assigned worker changes its own project copy. |
| **Checks** | The verifier checks a frozen copy and records the outcome. |
| **Review** | The head reviews the checked candidate; Control Center returns the recorded result. |

Expand the chat trace or open a task's **Changes**, **Checks**, **All events** and **Show record**
for evidence. A worker saying “done” does not verify anything. New department tasks require
passing independent checks and an approved head review of the recorded candidate before the
final verified reply. A direct Control Center answer has no invented worker trace. **Verified**
does not mean the change has been applied to your checkout, merged or deployed.

Use **Stop this task** on an active task. Wait for it to show **Stopped**, then use **Resume** to
continue. Held requests have **Start** and **Discard** controls. Closing the browser does not stop
work. Ctrl+C in the server terminal stops the page server; a task already started keeps running,
and requests still queued are held on the next start until you choose Start.

## Day-one limits

- The page runs one task per project at a time, with different projects allowed in parallel.
  Parts within one task can run in parallel. The default is two concurrent project tasks, and a
  worker assigned to several projects is never admitted to two page-managed tasks at once.
- A task whose roster includes Claude Code runs alone. Its file boundary is not verified; the
  page requires explicit consent. Codex is the suggested department-head runtime.
- A request targets one department on one project. Cross-project or cross-department work needs
  separate requests. The coordinator enforces the department's project roster.
- Each ordinary chat send creates an independent request. Control Center uses one bounded AI
  intake turn when needed; previous chat answers are not automatically included as context.
- Results are local candidates for review. Applying a change remains a separate deliberate action.
- Repository Git hooks, fsmonitor and content filters are disabled during coordinator Git
  operations. Git LFS files remain pointer files; this version does not fetch their contents.
- This is a local browser application on this Mac. Desktop installers, background service
  management, same-project simultaneous tasks, an Import button, a project filter and detail
  pages for pre-workspace history remain later work. The CLI can import older agent configurations.

Workspace configuration is `~/.workforce/workspace.json`. Each project has its own database,
lock, task records and candidate copies in `~/.workforce/projects/<project-id>/`. The page's queue
and launch logs live in `~/.workforce/serve/`. Use `--state-dir <folder>` for a separate workspace.
Removing a project registration does not delete its source folder.

The **[12 September integration record](docs/evidence/workspace/2026-09-12-dogfood.md)** distinguishes
browser walkthroughs, deterministic tests, real runtime results and remaining limits. The default
suite leaves 32 opt-in real-runtime tests skipped; that is not a claim that every historical
paid-runtime scenario was rerun. [Manual result review and application](docs/start-here.md#review-and-apply-a-result-deliberately)
explains how to inspect or apply a candidate in a separate review worktree.

The **[13 September harness evidence](docs/evidence/harness-experience-2026-09-13/README.md)** records
the current UI, model selection, folder browser, live Codex image/text intake and validation
boundaries. The **[harness research](docs/harness-research-2026-09-13.md)** compares first-party
runtime integrations and explains the remaining follow-up, skills and delivery gaps.

## Terminal workflow

Run `workforce` in a terminal for guided task intake, or use the existing explicit form.
This separate `--repo --agents` workflow remains available:

```
workforce run --repo . --agents ~/.workforce/agents.json \
  --task "Fix the pagination off-by-one" \
  --check "npm test"
```

| command | what it does |
| --- | --- |
| `workforce` | interactive terminal intake; defaults the repository to the working directory and shows checks before starting |
| `workforce doctor [--connect]` | read-only runtime discovery and readiness. `--connect` runs each runtime's own control handshake — a process, never a model turn — and is the only way to reach `verified_ready` |
| `workforce serve --open` | open the workspace UI on this computer |
| `workforce workspace show` | inspect projects, departments, workers and setup readiness |
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

## Terminal agent configuration

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
- The coordinator never resets, cleans, stashes or commits to your checkout. Work happens in a
  candidate copy; the result is a local candidate plus its evidence. Runtime containment limits
  are disclosed before a task starts.
- Coordinator state lives under `~/.workforce` (or `--state-dir`). Codex uses the tested file
  boundary; Claude Code has no verified OS file boundary, so its separate consent remains necessary.
- Exit codes are frozen: `0` verified candidate, `2` invalid input or configuration, `3` a
  required user action, `4` execution or validation failure, `130` interrupted.
- `--json` keeps stdout machine-readable: exactly JSONL for `run` (one event object per line, the
  final result object last), and every human line on stderr.

## Development

```
npm ci
npm run typecheck
npm test
npm run build
```

`docs/plan.md` is the authoritative specification; `AGENTS.md` holds the repository conventions.
