# Use AI Workforce

Double-click **Run Workforce.command** in
`/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`. The **run.sh** file beside it supports your
usual script workflow. Either launcher prepares the app, starts the frontend and backend together,
and opens your workspace. Running it again opens the same workspace. You can close the launcher
window while work continues. The **AI Workforce** app in Applications is also available.

Your frontend and backend live together in that source folder. Your saved team, projects and task
history remain in their existing data folder, selected automatically by the launcher.

## Add a project and ask for work

In **Projects**, click **Add project** and choose the repository folder. The app checks the folder
and fills in its name. Save it, then describe what you want in **New request**.

Your existing team is available automatically. You do not need to place agents on a project or
choose the department, specialist, model or test commands for a codebase explanation.
Control Center interprets the request, the department head plans it, and the coordinator reserves
available specialists using their strengths and workload. Different projects can run concurrently
within your saved capacity; a named worker is reserved for one active run at a time.

For example:

> Look through this codebase and explain its features, architecture and important limitations.

That creates **analysis work**. Workers inspect a frozen source snapshot, produce reports, and the
department head checks the findings. A completed result is labeled **Reviewed analysis** with
unchanged-source evidence. It does not imply code changes or passing application tests.

For a request to implement or fix something, the system uses isolated candidate workspaces and
independent checks, followed by head review. It discovers existing project checks where supported.
If the project has no meaningful verification configured, implementation still needs a suitable
check before it can be accepted. Optional custom verification lives in project settings.

A repository needs a committed base. Workers inspect that committed version; existing uncommitted
changes remain in your original folder. The harness does not reset, clean or stash your checkout.

## Follow everything in Headquarters

**Work across projects** shows current requests together: project, assigned people, individual
objectives, current phase, latest recorded actions, task evidence and timing. Filter by project or
status and inspect any task or person without leaving the workspace.

**Team workload** shows Tom Chandler, department heads and specialists with their roles and current
assignments. **Reserved**, **Working** and **Available** describe different recorded states.
Historical attempts that never started stay in history, rather than appearing as approval requests.

The right task panel shows the work, findings and evidence. Optional **Agent settings** and technical
diagnostics are folded away. Normal sends use **Automatic team**; routine authorized work does not
need a separate handoff approval.

## Connect Codex or Claude

Open **Connections** and click **Connect** beside the installed coding agent. The app detects it,
saves the Workforce MCP connection and checks the tools. An already open coding-agent conversation
may need reopening to load that connection. See [Connect your coding agents](mcp.md).

Then ask your coding agent naturally to send the complete plan or PRD to Workforce for the saved
project and start it. For later work, ask it to save the plan without starting. The complete brief
is retained; no copied tool identifiers or setup commands are needed.

**Issues** organizes work by project in Backlog, To Do, In Progress, In Review and Done. A saved
issue starts only when you choose **Send to Control Center** or explicitly ask your connected agent
to start it. Recorded progress comes from the same coordinator and queue.

## Optional settings

The existing team works across projects by default. In **Agents**, **Project access** can optionally
restrict a specialist to selected projects. Empty selections only restrict work when you explicitly
choose that restricted mode. Archiving a person preserves historical records.

Runtime, model and effort settings are optional overrides; model choices come from your installed
runtime. If an agent is signed out, sign in through that coding agent and refresh its connection.
Workforce never asks for the provider token. Installed runtime capability limits and authentic
failures remain visible; automatic setup does not fabricate a successful run.

Source changes, reviewed analysis, independently checked code, integration, and deployment are
separate facts. Open a task's evidence to see what actually happened.
