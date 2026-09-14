# Agents Office assessment

Inspected 9 September 2026. Repository: `/Users/shebin_mohan_k/CODES/CursorFiles/agents-office`. Branch `main`, HEAD `a6247f96ead512605166194fb955b9e8a0d34720`, package version `3.4.0-beta.1`. Existing modifications to `package-lock.json` and `src/braingraph.js` were preserved. This report compares the inspected application with the current AI Employee master plan; it does not assess the readiness of a separate workforce implementation.

**Recommendation:** use this as a reference for the visual office and task interactions. Consider reusing presentation code only with appropriate licensing. Its backend would need substantial replacement to support the planned developer workforce.

The application contains both an elaborate office simulation and a real Claude task/chat execution path. The simulation continues when the interface connects to the real backend. That distinction explains why the office looks productive before you assign anything.

**What was verified on your machine**

- The existing browser page at `http://localhost:4520/` rendered the six department pods, central Brain, connector bar, and right task panel.
- In one browser snapshot, the panel showed `LIVE · CLAUDE`, 125 total entries, 35 in progress, two waiting, and 84 done. These counts change as the simulation runs.
- A read-only request to `/api/tasks` returned an empty array: zero saved backend tasks. `/api/health` reported the Claude CLI backend, the supplied Northgate Studio configuration, 35 notes, and three shipped skills.
- The server reported one connected Chrome DevTools MCP server and a Supabase connector requiring authentication. These are discovery results, not proof of successful agent tool execution.
- No inference task, chat submission, approval, connector write, build, installation, or source edit was performed for this audit. A real Claude run and its deliverable remain unverified here. The source provides an execution path; the LIVE badge only establishes successful contact with the application server.

**Why the office starts busy**

[src/tasks.js:198](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:198) unconditionally seeds every agent with an in-progress sample task, adds random backlogs, and invents earlier completions. Sample customer names and task templates come from the same module. Its simulated tasks take 90–240 seconds, then can pass a predefined next task to another desk. Once an agent runs out of tasks, another sample job appears after a short delay.

Connecting to the server [appends saved real tasks](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:345); it does not clear the samples. The [animation loop](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:568) keeps the simulation running. Activity history and department metrics also have generated inputs in [src/main.js:992](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/main.js:992).

Consequently, the 35 desks are not evidence of 35 active model sessions or background jobs. Those simulated tasks do not invoke Claude. An unfinished *real* saved task can, however, be picked up when a browser page connects.

**How it is implemented**

| Layer | Implementation | Practical meaning |
| --- | --- | --- |
| Office scene | Three.js, orthographic camera, procedural desks/people/plants, fixed pod positions | The miniature isometric appearance is created in code. |
| Interface | Plain JavaScript, HTML and CSS; DOM cards layered over the canvas | It does not require React or a game engine. The readable controls are ordinary HTML. |
| Build | esbuild bundles the app and Three.js into a self-contained HTML file | The same bundle can open as an offline demonstration or be served locally. |
| Backend | Small Node HTTP server in `serve.mjs` | Hosts the bundle, exposes JSON endpoints, calls Claude, reads/writes local files. |
| Agent definition | Fixed seat identity plus name, role, job description, brief and skills | Agents are specialized prompt configurations sharing the backend. |
| Model access | Fresh `claude -p` process; optional Anthropic SDK path | The inspected backend implements Claude, despite the UI also displaying a ChatGPT logo. |
| Knowledge | Markdown notes, wiki links, keyword-based context selection | The Brain is a real note graph, not a planning agent or semantic retrieval engine. |
| Persistence | `data/tasks.json`, Markdown deliverables, feedback and interview files | Simple and inspectable, but not a transactional workforce state store. |

Useful source entry points: [scene and camera](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/main.js:19), [geometry builders](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/builders.js), [layout and palette](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/data.js:17), [CSS](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/shell.html:8), and [build](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/build.mjs:1).

The visual hierarchy is effective: pastel pods give departments stable identities; a central shared knowledge area connects them; overview cards summarize activity; selecting an agent reveals detail; the persistent right panel keeps tasks accessible independently of the camera. Cream backgrounds, thin borders, rounded cards, serif display typography and restrained motion create a calmer presentation than a terminal wall. At the inspected viewport, some cards overlap the scene, so arbitrary team sizes would need layout work.

**The real task path**

1. The user selects a department and submits a task through the right panel.
2. `POST /api/tasks` asks Claude to choose one agent and return a title, short plan, rationale and estimated duration. The server saves the task as queued.
3. The browser eventually calls `POST /api/tasks/:id/run`.
4. The server constructs a prompt from the selected role, brief, skills, standing feedback, company notes and relevant note excerpts. It starts a fresh Claude invocation with permitted connectors/web tools.
5. The returned text becomes a Markdown deliverable, linked to the notes supplied as context. The browser shows the result and refreshes the graph.

See [router](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/serve.mjs:169), [execution prompt](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/serve.mjs:181), [persistence](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/serve.mjs:245), and [browser scheduling](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:325).

This is useful business-assistant plumbing. It does not decompose a software project among collaborating workers. The visual handoff chains are scripted sample data. Department leads have useful setup interviews, but their role descriptions do not establish implemented autonomous management.

**Approvals, updates and progress need different meanings in our product**

| UI feature | What the inspected code does | What our implementation should do |
| --- | --- | --- |
| Approval request | A timer chooses a working agent and supplies canned request text/mockup. | Show a recorded decision tied to the exact task, attempt and proposed operation. |
| Approve/reject | Changes browser state and emits a canned response; no backend approval request. | Validate and persist the decision, then permit or refuse the matching operation. |
| Progress percentage | Real tasks use elapsed time / 45 seconds, capped at 92%, then finish when the response arrives. | Show observed phases and evidence; use an activity indicator when percentage is unknown. |
| Connector pulses | Real tool names are collected, then returned to the UI after the run finishes. | Stream observed tool-start/tool-end events and show failures as well as usage. |
| Done | A generated result is saved; failed runs also use `done` with an error flag. | Distinguish produced output, failed work, validated results and human delivery decisions. |

Evidence: [approval handlers](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/main.js:923), [random approval timer](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/main.js:1217), [estimated progress](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:575), and [result handling](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/serve.mjs:260).

The actual outbound-action restriction is prompt text telling Claude to act only when explicitly asked. The same [prompt](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/mcp.mjs:116) tells it not to ask a question mid-task. The attractive approval interaction therefore cannot be relied on as an execution gate.

**Ideas worth carrying into AI Employee**

- An optional office/team overview, backed by the same state as a practical task workspace.
- One persistent task panel with whole-office and department filters, clear waiting reasons, timestamps and direct links to output.
- Agent detail views combining role, current task, conversation, activity and artifacts.
- A short brief for standing instructions, plus reusable skills with templates for repeatable jobs.
- A setup interview that translates user answers into visible, editable agent configuration.
- Corrections separated into one-off feedback and standing preferences. This is file-backed prompt memory, not model training.
- A knowledge/artifact graph that preserves source relationships and provenance, separate from the task dependency graph.

The [onboarding questions](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/onboard.mjs:16) and [feedback classifier](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/learn.mjs:54) are particularly useful product patterns.

**Why the backend is a poor fit as our underlying layer**

Our [master plan](/Users/shebin_mohan_k/Documents/ChatGPT/AI%20Employee%20System/AI-EMPLOYEE-SYSTEM-PLAN.md:118) requires Codex and Claude adapters, arbitrary custom agents, controlled delegation, actual peer communication, isolated candidate workspaces, validation and recovery. This application does not supply those guarantees:

- Six departments and 35 seats are fixed. The [roster validator](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/roster.mjs:24) ignores new IDs and department/lead changes. Renaming a seat is supported; creating a custom organization is not.
- The [Claude runner](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/serve.mjs:81) explicitly disables Bash, file reading/editing, and subagents, runs from a temporary directory, and disables session persistence. Renaming agents to Frontend Developer or QA would not add repository execution.
- The browser controls queue advancement. [Reloaded unfinished tasks](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:354) are requeued, while the server's run endpoint has no in-flight ownership guard. Reloads or multiple tabs can cause duplicate execution. This is a source-derived risk, not a reproduced incident.
- JSON writes lack transactional recovery; read/parse failures become an empty list. Date-plus-title note filenames can overwrite a previous same-day result with the same title.
- Every agent receives the same globally permitted connected MCP servers. Department wiring and an agent's usual-tool list do not enforce separate capabilities: [mcp.mjs:104](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/mcp.mjs:104).
- A failed routing request [falls back to a browser-only task](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/src/tasks.js:312), which can subsequently simulate completion. The chat `add task:` shortcut also uses that local task path. Failure should instead remain visible and actionable.
- The HTTP server has no application authentication checks and binds without a loopback address. The existing listener was visible on `*:4520`; external reachability was not tested. This needs correction before treating it as a shared service.

These are architectural differences, not a reason to dismiss the interface. Replacing the backend would amount to building most of the workforce core we already specified.

**Reuse and licensing**

The repository includes [PolyForm Noncommercial 1.0.0](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/LICENSE:1). Its [README](/Users/shebin_mohan_k/CODES/CursorFiles/agents-office/README.md:15) says personal and internal use are free and prohibits building a paid product on it. The [official license](https://polyformproject.org/licenses/noncommercial/1.0.0) grants noncommercial purposes and describes personal uses without anticipated commercial application; it does not give a general commercial internal-use permission. That discrepancy should be resolved with the rights holder before relying on the code for business use.

For a commercial foundation or copied frontend, obtain explicit written permission covering the intended use. Extracting only the scene or panels does not remove their license restrictions. An independently implemented interface informed by the product concepts avoids depending on this source license; use original code and assets, and consider any separate branding/design rights.

**A concrete direction**

Keep the planned coordinator and runtime-adapter architecture. Add an office view that consumes its recorded agents, tasks, attempts, events, decisions and artifacts. Make the right task/evidence panel the main work surface; use the office to navigate and understand ownership.

Start with one configurable team and a few agents. A useful demonstration is: submit one repository task; see the actual worker start; observe a real clarification or approval if needed; inspect a resulting diff; run the configured checks; and see the correct validated or failed state. Reloading the UI must preserve that history without starting duplicate work. Idle agents should remain visibly idle.

The first presentation milestone can replay recorded workforce events. The next connects live events and decisions to the coordinator. Supporting arbitrary departments is a separate schema/layout task. Adopting or rewriting this application's backend is unnecessary for either milestone.

The current plan schedules polished UI after the core; this assessment records your new visual preference without changing that release scope or claiming the current workforce has passed its acceptance criteria.
