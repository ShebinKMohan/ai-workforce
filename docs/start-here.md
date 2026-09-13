# Start using AI Workforce

AI Workforce is a local harness for installed coding agents. Choose a project and send a message
to Control Center, the AI orchestrator. It answers, asks for context, or routes work to a department
head. The head plans and delegates, workers execute, and independent checks plus head review
support the result returned in Chat. Use the UI to configure the team and follow actual work.

This guide covers the browser workspace shipped with `workforce serve`. The dated
[integration record](evidence/workspace/2026-09-12-dogfood.md) records the original workspace proof.
The [13 September harness evidence](evidence/harness-experience-2026-09-13/README.md) covers the
current chat, model choices, attachments, folder browser and real Codex multimodal intake.

## Open it

On this Mac the source checkout is:

```text
/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee
```

Start from that checkout:

```sh
cd "/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
npm start
```

For a Finder shortcut on this Mac, double-click:

```text
/Users/shebin_mohan_k/Documents/Workforce-Takeover-2026-09-12/Open Workforce.command
```

It opens the page when the server is already answering, or builds and starts the server in a
terminal. Keep that terminal open while using the page.

The default URL is **http://127.0.0.1:4317/**; use the URL and state folder printed by your server.
The 13 September dogfooding workspace uses port **4421**. If `workforce` is not
linked, `node dist/cli/index.js serve --open` starts the last build directly. `npm start` builds
the current source first. For a fresh installation, run `npm ci` once, then `npm start`.
Run `npm link` once to make the optional `workforce` commands below available. This machine
was checked with Node.js 26.8.1; the package requires Node.js 22.13 or newer.

If port 4317 belongs to another application, start on a free port without stopping that app:

```sh
workforce serve --port 0 --open
```

For an independent trial workspace, choose a different state folder:

```sh
workforce serve --state-dir "$HOME/.workforce-trial" --port 0 --open
```

That separate workspace starts empty. Use the same `--state-dir` when restarting it. The normal
workspace uses `$WORKFORCE_STATE_DIR` when set, otherwise `~/.workforce`.

## Your first ten minutes

### 1. Check your coding tools

The main page opens the Office. A fresh workspace shows only Control Center, with no
departments, worker desks or employee avatars. The setup checklist is available at
`/workspace/#/home`; Settings is at `/workspace/#/settings`. AI Workforce looks for Codex and Claude Code using passive
version and sign-in checks. Opening the page, editing your team and checking tools starts no
model task. Readiness reported by a tool is distinct from a completed real task.

If Settings reports a signed-out tool, run its displayed command in a terminal:

```sh
codex login
```

or, for Claude Code:

```sh
claude auth login
```

Then click **Check again** in Settings. You do not enter a token into AI Workforce. Runtime,
model and reasoning-effort choices are available in Chat and the settings/editors. Model lists
come from the selected installed runtime; use refresh if its available choices have changed.

### 2. Add a project

Open **Projects** in the Office header, click **Add a project**, then **Browse folders**. Navigate
to the local Git repository and choose **Use this folder** to run Git inspection. **Enter a path**
remains an optional alternative.
Review the repository, its last commit and the checks the verifier will run. Name it and add it.
A folder without a commit cannot be used yet. A project without a check can be saved, but cannot
receive a task until you add a check in its project page.

Adding a project creates no department, head or worker. Team setup is a separate action.

Checks are commands that succeed with exit code zero. For example, `npm test` is suitable when
it runs the project's meaningful tests. AI Workforce executes command arguments without a shell;
use separate checks for separate commands rather than `npm test && npm run build`. It reads
project-provided checks from the last commit. Tests that need downloads, network services or
unavailable dependencies may fail under the verifier's restricted environment; the task page
retains that failure as evidence.

Coordinator Git operations disable repository hooks, fsmonitor, text conversion and
clean/smudge/process filters. This avoids executing repository-configured programs during setup
and snapshotting. Git LFS entries remain pointer files; AI Workforce does not fetch or materialize
their large-file contents. Choose a first task that does not require those missing assets.

Workers start from the repository's committed HEAD. If your requested change depends on local
uncommitted edits, first decide which committed version you want them to use. AI Workforce does not
silently include those edits, and it does not reset, clean or stash your folder.

### 3. Create a department

Return to the Office and click **+ Department**. Configure the department and its head:

- **Head:** enter a name, coding runtime, optional model/effort choices and instructions. The head decides
  how to split and assign each request and uses the read-only analysis policy.
- **Department:** choose a name and color. Names may repeat when different notes tell them apart,
  such as Engineering / Payments and Engineering / Storefront.

Click **Create department** to save the department and its head together in one revisioned
operation. Its room and head workstation appear in the Office. No task starts.

Use **Add agent** to add workers to that department. Set each worker's name, runtime, model and
instructions, and select the projects it may work on. The same department room grows to contain
every saved worker; there is no four-seat limit or separate overflow department. You can create a
department before adding a project, then assign projects when adding or editing its workers.
The **Agents** directory keeps the full configured roster available. Model and reasoning effort
can be selected in the agent editor's options. Removing an agent archives it from the active
directory while preserving historical records; archived agents can be restored.

No starter department is silently saved. A worker assigned to no projects remains unassigned
and cannot receive work. Only workers in the chosen department and assigned to the chosen
project enter its roster. Editing configuration affects future work; a task keeps its saved
configuration for execution and resume.

### 4. Send a small first task

From Office, use Control Center's **Chat** tab. Choose the project, optionally select Control
Center's runtime/model/effort, and describe one change whose result you can inspect. The composer
has no department selector: Control Center chooses the responsible team. For example, on the
provided rounding demo:

> applyDiscount truncates instead of rounding to the nearest cent. Fix the underlying defect in
> src/. Do not modify anything under test/.

That prompt is specific to the rounding demo; use an equivalent bounded request for your own
repository. Click the arrow labelled **Send to Control Center**. The request is recorded before
its route is resolved; the chat then shows the chosen department and subsequent execution.
The selected runtime/model/effort apply to Control Center for this message, while department
heads and workers retain their own settings. Selecting a room or employee does not change routing.

Use **Attach files or images**, or drag files into Chat, to add multiple attachments. Remove a
chip to exclude that file before sending. The limits are 8 files, 5 MiB per supported native image,
10 MiB per other file and 25 MiB total. Supported images use native model input; Claude also
accepts native PDFs. Other files are staged for runtime tools, with bounded text excerpts where
applicable. Unsupported interpretation is not silently promised for arbitrary binary formats.
Each ordinary send creates a new request; earlier chat answers are not automatically included.

If anyone on the roster uses a runtime without a verified file boundary, the page explains the
limit and requires a consent checkbox. Claude Code currently falls into this category even for
an analysis head. Running it alone prevents concurrent page-managed project tasks; it does not
create an OS sandbox. Choose Codex for a first contained trial.

## See what is happening

**Office** is an interactive 3D scene built from your saved workspace. The Control Center sidebar,
employee focus, directory and settings surround its rooms, desks, chairs and people.

- An empty workspace has only **Control Center**, the AI intake orchestrator. Its runtime is
  configurable; coordinator code separately owns capacity, permissions and verification.
  There are no sample departments or placeholder employees.
- Each saved department has its own room and head. Adding workers expands that same room to
  fit its complete roster, including the fifth worker and beyond. Department and employee IDs
  determine membership; repeated department names do not merge teams.
- Select a department to focus its room, or select an employee to inspect its recorded assignment
  and edit its configuration. **Agents** opens the searchable directory; **Add agent** adds a
  worker to a saved department. **+ Department** creates a department and head together.
- Drag the scene to pan, scroll to zoom, or use the zoom and Fit controls. With the scene focused,
  keyboard arrows pan, **+ / −** zoom, and **0 / Home** fit the office.
- Status labels, task counts and communication packets come from recorded workspace state.
  The phase legend explains intake, routing, work, checks, review and reply. Scene motion can
  be paused and respects reduced motion; furniture alone does not establish runtime execution.

The resizable **Control Center** beside the scene has three tabs:

| Tab | What it does |
| --- | --- |
| Chat | Sends messages and attachments to Control Center with project context. The main response stays readable; one collapsed trace exposes routing, actors, output, checks and usage when expanded. Direct answers have no invented worker trace. |
| Activity | Shows recorded work and its current state. Open a task to inspect its details and full evidence. |
| Runtimes | Shows configured bindings and reported runtime information. A configured model is distinct from the effective model recorded by a real task. |

The **Projects** header link opens the workspace project pages. Home/setup, Departments, Tasks
and Settings remain available in the workspace interface at `/workspace/`. The original employee
directory and settings panels are also available directly in Office. Saving configuration starts
no model task; changes must be saved before they appear in the persisted roster.

Use your page server's printed URL for execution; **4317** is the default port. The original reference at
**http://127.0.0.1:4318/** is a separate prototype. Its sample state is not execution evidence
for your workspace.

**Tasks** gives the recorded history grouped by project. Open a task for its current actors,
five phases and evidence:

| Phase | Evidence to look for |
| --- | --- |
| Sent | Request recorded, with an explicit wait reason if queued. |
| Department head | Planning started, plan proposed through the head tool, validation and named worker assignments. |
| Work | Worker attempt and file activity in its candidate copy. |
| Checks | Frozen candidate identity and verifier-executed check outcomes. |
| Review | The head's review of the checked candidate, followed by Control Center's recorded final response. |

Expand **Changes** to inspect the recorded patch; **Checks** shows who executed each check and
whether it counted. **All events** is the ordered record. **Show record** exposes technical
identifiers and revisions when you need them. A completed planning phase uses neutral styling;
it is not verification. A worker reporting a pass cannot replace an independent check.

For new department tasks, **Verified** requires configured checks to pass and the head to approve
that recorded candidate. It still needs your review for requirements the checks cannot establish.
It is a local result: no automatic
application to your active checkout, remote push, merge or deployment has happened. Preserve
its candidate and patch while deciding how to apply the change.

The terminal reads the same project data. Find the project and run IDs in Show record, then use
the project's state root (replace the example IDs):

```sh
workforce status <run-id> --state-dir "$HOME/.workforce/projects/<project-id>"
workforce status <run-id> --state-dir "$HOME/.workforce/projects/<project-id>" --json
workforce watch <run-id> --state-dir "$HOME/.workforce/projects/<project-id>"
```

## Review and apply a result deliberately

There is no **Apply** button in this version. The task's **Changes** disclosure displays the
recorded patches and **Checks** displays the verifier receipts. `workforce status … --json`
also lists artifact paths and their hashes. Paths in its `artifacts` list are relative to
`<stateRoot>/runs/<run-id>/artifacts/`, where `stateRoot` is the project's state root printed in
that status document.

A workspace request uses the planned path. Its final summary is:

```text
<state-root>/projects/<project-id>/runs/<run-id>/planned-result.json
```

Read `accepted`, `base.revision` and `combination.combinedRevision`. Use the **combined** revision
for a task with several parts; applying every attempt patch could include superseded repairs.
Only proceed with a result whose final acceptance and checks you have reviewed. The candidate
commit is in the registered repository's Git object database because its workspaces are linked
Git worktrees.

For example, substitute the actual paths and the two recorded revisions below. The first command
exports the complete candidate change to a new patch file; it does not apply anything:

```sh
git -C "/path/to/project" diff --binary --no-ext-diff --no-textconv <base-revision> <combined-revision> > "/path/to/reviewed-task.patch"
git apply --stat "/path/to/reviewed-task.patch"
```

To try it without changing your active checkout, create a separate review worktree with a unique
branch name, then check the patch before applying it there:

```sh
git -C "/path/to/project" worktree add -b codex/review-my-task "/path/to/my-task-review" <base-revision>
git -C "/path/to/my-task-review" apply --check "/path/to/reviewed-task.patch"
```

Once you choose to apply it, this is the explicit write step:

```sh
git -C "/path/to/my-task-review" apply "/path/to/reviewed-task.patch"
```

Run the project's checks and inspect the diff in that review folder. Applying, committing and
merging remain your deliberate Git actions; AI Workforce has not done them for you. If the target
base or changes differ from the reviewed candidate, the earlier acceptance does not verify that
new combination.

## Stop, resume and restart

Use **Stop this task** in the task page. The page shows **Stopping** until the process has settled;
do not interpret the click itself as proof it stopped. Once stopped, **Resume** continues from
saved state under the same project. Planning interrupted before a validated plan may need a new
head attempt; a validated plan and completed work are retained by the recovery path.

Closing a browser tab leaves tasks running. Ctrl+C in the `workforce serve` terminal stops the
page server. Already-started tasks continue independently. Start the same server again to read
their state. A request that was waiting when the page server stopped becomes **held**, and its
**Start** button explicitly returns it to the queue; **Discard** removes the pending request.

The page only offers controls it can safely perform. A task that was started elsewhere may have
read-only status and identify where to manage it. For terminal recovery of an interrupted run:

```sh
workforce resume <run-id> --state-dir "$HOME/.workforce/projects/<project-id>"
```

Use the page for ordinary multi-project task submission and recovery so its admission rules
apply. A separately launched CLI process is not the same thing as a page-managed queued request.

## Configure repeat use

Use **Projects** to edit names and checks and inspect the assigned team. Use **Departments** to
edit heads, workers, instructions and project assignments. **Settings** contains runtime status,
limits, the workspace file and earlier history. The default admits two simultaneous project
tasks. Each project still runs one at a time, a shared worker waits until available, and a roster
containing Claude Code runs alone. Parts of one planned task can run concurrently under the
per-task limits.

Control Center settings select its AI runtime, model, effort and orchestration instructions.
Optional project specialization rules provide explicit routing. The notification control can
alert you when work finishes or needs attention while the page is running; browser support and
permission are required. It does not deliver notifications after the page or server closes.

The CLI offers the same workspace operations. Inspect the exact IDs and setup state with:

```sh
workforce workspace show
workforce workspace show --json
workforce --help
```

To import a pre-workspace agent configuration, use the CLI command shown in Settings. Import
creates a department and assigns no worker to a project; review it and assign projects before
sending work. This version does not include a UI Import button.

## Find your data

```text
~/.workforce/
  workspace.json                     projects, departments, workers, runtimes and limits
  projects/<project-id>/
    state.sqlite                     this project's task and evidence records
    coordinator.lock                 this project's execution ownership
    rosters/                         saved eligible teams
    runs/<run-id>/                    request, configuration, events and artifacts
    workspaces/                      candidate and verification copies
  serve/                             page request queue and launch logs
```

Treat the workspace file, databases and candidate directories as local work to preserve.
Removing a project registration does not delete its repository. Earlier tasks in the old root
state remain listed read-only in Settings; full detail pages for those pre-workspace tasks are
not included yet.

## When something needs attention

| What you see | What to do |
| --- | --- |
| Page server is not answering | Start `workforce serve` with the same state folder and use its printed URL. |
| No coding tool, or signed out | Use Settings' installation/sign-in information, then Check again. |
| Project has no check | Add a meaningful check on its project page. |
| No department can take this project | Give the department a head and assign at least one of its workers to this project. |
| Waiting | Read the reason: the project, shared worker, concurrency cap or exclusive task is busy. |
| Workspace changed since this page read it | Your editor draft is kept; inspect the fresh configuration before saving again. |
| Workspace file could not be read | Correct the file or restore your known-good copy. The page refuses to overwrite malformed data. |
| No usable plan | Read the recorded rejection; the head could not produce an eligible bounded plan. No worker was started from it. |
| Did not finish / a check failed | Open Checks and All events. Fix the prerequisite or clarify the task using the recorded failure. |
| Stalled / Stopped | Inspect the record and use Resume when offered; missing evidence remains unverified. |

Same-project simultaneous tasks, a workspace project filter, richer steering and question-answer
flows, a long-lived workspace coordinator, desktop packaging and automatic local application
remain later milestones. The real Claude Code department-head path still needs its own live
verification. The current release is intended for local engineering dogfooding within these limits.


The takeover test baseline included **32 skipped tests** for opt-in real-runtime suites. A passing
default test run does not mean every historical paid-runtime scenario was re-executed. The dated
integration record distinguishes the real task run during this takeover from deterministic coverage.
