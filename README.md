# AI Workforce

A local harness for your coding agents. Add projects, create departments with heads and workers,
and send a message to **Control Center**, your AI orchestrator. It answers from the supplied
context, asks a focused question, or routes project work to the responsible department. The head
plans the work, workers change isolated copies, and an independent verifier checks the candidate.
The head reviews the checked result before Control Center returns the final response.

The desktop workspace combines a readable task conversation, an interactive 3D Office, project
and agent management, and real execution records. Codex and Claude Code use their installed CLIs
and configured provider authentication; AI Workforce has no separate product account. Sending a
message that needs AI uses the selected runtime's model allowance. The CLI command and data
directory retain the name `workforce` for compatibility.

## Start here

From this repository on macOS, with Node.js 22.13 or newer and a supported coding CLI installed:

```sh
npm ci
npm start
```

Open **[http://127.0.0.1:4317/](http://127.0.0.1:4317/)** if the browser does not open. Keep the
server terminal open while you use the page. After the first installation, **`npm start`** builds
the current source and opens the workspace. For the `workforce` commands in this guide, run
`npm link` once from the checkout; then `workforce serve --open` starts the last build directly.
`node dist/cli/index.js serve --open` is the equivalent without a global link.

A new workspace opens an empty Office with only Control Center. To get started:

1. **Check your coding tools.** The page detects installed Codex and Claude Code without a model
   turn. If a tool is signed out, Settings gives its login command. Check again after signing in.
   Control Center, runtime defaults and agent editors offer the models and reasoning efforts
   reported by each installed runtime; unavailable choices remain visible.
2. **Add a project.** Click **Browse folders** to choose an existing Git repository with at least
   one commit, then **Use this folder** to inspect it. Review the
   detected checks, or enter a check such as `npm test`. Work starts from its last commit;
   uncommitted edits stay in your original folder and are excluded from the task. Adding a project
   creates no department or employee.
3. **Create a department.** Use **+ Department** to name the department and configure its head.
   Both are saved together. Use **Add agent** to add workers and select their projects. Each worker
   gets a workstation inside the same growing department room. A worker with no project assignment
   receives no work.
4. **Send your first task.** In **Chat**, choose the project, describe a bounded change and click
   **Send to Control Center**. Optionally select its runtime, model and effort for this message.
   Control Center chooses the department; selecting a room or agent only changes inspection
   context. Department heads and workers keep their own runtime settings.

Use the attachment button or drag files into Chat to include documents, source files or images.
You can remove individual files before sending. A message accepts up to **8 files**, **5 MiB per
supported native image**, **10 MiB per other file**, and **25 MiB total**. Delivery depends on the
runtime: supported images use native image input, Claude also accepts native PDFs, and other
files are supplied as staged references with bounded text excerpts where applicable. Uploading
a binary file does not imply the selected model can interpret its format.

Start with a small change in a demo or development repository whose tests you can interpret.
For the full walkthrough, troubleshooting and repeat-use commands, read **[Start here](docs/start-here.md)**.

## Follow the work

**Office** shows your saved departments and employees in an interactive 3D scene. A department's
room grows around its full roster, including the fifth worker and beyond; there is no fixed set
of islands or four-seat limit. Pan, zoom or select a room or employee to inspect its real context.
The central **Control Center** represents the AI intake agent. Its chosen runtime interprets
requests; coordinator code enforces scheduling, worker capacity and execution boundaries.

The **Control Center** has three tabs: **Chat** keeps your message and the main response readable,
with execution traces collapsed until you expand them; **Activity** shows recorded work and links
to its evidence; **Runtimes** shows runtime information and configured agent bindings.
**Projects** opens the workspace pages at `/workspace/`,
where Home/setup, Departments, Tasks and Settings remain available. **Agents** opens the full
directory and **Add agent** opens the worker editor. Typing a draft starts no model task. Drag
the right panel's divider to resize it. Scene packets and phase labels reflect recorded intake,
delegation, work and review; idle agents do not simulate tasks. Scene motion can be paused and
respects reduced motion. Opt-in browser notifications report completion or work needing attention
while the page is running, subject to browser support and permission.

The default application port is **4317**; use the URL printed by your server if you choose another
port. The original prototype on **4318** is a visual reference with static demo data. The dated
13 September live checks used a separate workspace at **4421**.

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
