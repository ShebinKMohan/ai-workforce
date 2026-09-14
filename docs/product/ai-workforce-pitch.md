# AI Workforce

**Describe the work. Follow the result.**

AI Workforce brings your installed coding agents into one local workspace—with clear owners, separate working copies, checks and review.

**Product status, 14 September 2026:** local developer preview. The installable Rust desktop application is the planned direction. No standalone Rust installer is available in this snapshot.

This is reusable presentation copy. The [standalone HTML presentation](ai-workforce-pitch.html) contains the same product story, illustrations, navigation, a capability appendix and print styling.

## 1. The promise

Your AI tools. One working team.

Describe a task, choose a project and follow the work from the first brief to a reviewable result. AI Workforce coordinates supported installed Codex and Claude Code tools through one local workspace.

Built for developers who already use AI coding tools and want less manual coordination between them.

## 2. The problem

You have capable agents. You are still the coordinator.

You repeat context, choose who works, move findings between conversations, watch failures and decide whether the result actually works. Every extra tool can create another handoff.

AI Workforce brings the request, the team, the work and its evidence together. Less manual coordination is the goal; no broad speed advantage has been established.

## 3. How work moves

1. **You describe the work.** Choose a project, explain the outcome and attach useful context.
2. **Control Center routes it.** It answers, asks for missing intent or sends work to the right department.
3. **The head assigns it.** The head plans with available specialists. Workers act in separate project copies.
4. **The result is checked and reviewed.** Code changes face independent checks and a separate head review.
5. **The result returns.** See the answer, changes, checks, owners and anything still unresolved.

Plans and reviews are recorded actions. A written promise to act does not start work. A simple reply does not create a pretend coding run.

## 4. Use the tools you have

Keep your coding tools. Give them a shared workspace.

- Detect supported Codex and Claude Code installations and inspect readiness.
- Set up and verify the local coding-agent connection through the interface.
- Choose the tool, available model and supported effort independently for Control Center, heads and workers.
- See connection setup, account sign-in and execution readiness as separate states.
- Keep saved model choices visible when an installed tool’s catalog changes.

Passive discovery and connection checks start no paid model turn. Existing provider accounts, limits and installed-version capabilities still apply. The recorded complete department workflow uses Codex; complete Claude department-head proof remains open.

## 5. Build a team that fits your work

Create departments, appoint heads and define worker specialties. Available specialists can serve registered projects automatically, with optional project restrictions.

Edit job titles, instructions, capabilities and runtime settings. Move responsibilities, replace heads and archive identities while preserving historical work. The same named worker is reserved for one active assignment at a time.

A one-click starter team includes:

- Architecture & Delivery
- Frontend & Design
- Backend & Data
- Platform & Security
- Quality Engineering

Bundled portraits personalize the view. Expressions are decorative; recorded task state shows who is working.

## 6. See the whole workload

Headquarters shows the team and current operational state. Issues and the task feed hold requests, results, owners and next actions.

The six issue lanes are **Backlog, To Do, In Progress, In Review, Done and Canceled**. Compact cards show a title, project, recorded duration and people involved. Open a card for the conversation, metadata, checks and deliverables.

Use project filters and inspect priority, department, actual owners and execution phases. Manual Done, an answered question and a checked code candidate retain different meanings. Moving a card alone starts no agent.

## 7. Trust the result through its evidence

A useful result comes with its evidence.

- **Separate working copies:** keep the user’s active checkout out of the routine editing path.
- **Independent checks:** record which checks ran, the outcome and the exact candidate they inspected.
- **Separate head review:** review the change against the request. Missing or failed checks cannot become approval.
- **Inspectable delivery:** keep changes, feedback and unresolved items with the final result.

Code work requires acceptance checks and head review. Read-only analysis uses a report, unchanged-source checks and head review, and is labeled **Reviewed analysis**.

A verified candidate is a checked local result. Applying it, merging it or deploying it is a separate step. Separate copies do not establish full filesystem security.

## 8. Keep going after a failure

When a run stops, the context should not disappear.

Requests, attempts, errors and candidate artifacts stay recorded. Clear states distinguish capacity waits, sign-in needs, rejected review, failed checks and stopped work.

Supported stop, resume and retry actions use saved settings and preserve previous attempts. Known temporary provider errors have finite automatic retries. App-managed capacity covers concurrent projects and intake; reservations and active work remain distinct.

Canceling records a cancellation. It never creates a successful outcome.

## 9. Bring context from a conversation or a plan

Attach files in chat, continue an opened conversation, or submit a plan from a connected Codex or Claude client.

- Preserve the request and attachments through planning, assigned work and resumed runs.
- Include bounded prior conversation context when submitting a follow-up from an opened conversation.
- Let external coding agents read registered projects and issues, create or update issues and submit complete plans through the local MCP connection.
- Save a plan without dispatching. Explicit Start sends it through the same routing, checks and review.
- Preserve full plan text and submission identity so repeated identical submissions return the original record.

Native image and document support depends on the chosen coding tool. A saved, verified connector may require reopening an existing external chat before that chat can use it.

## 10. A recorded end-to-end example

A real local demonstration on 13 September 2026 submitted a complete brief through an external MCP client and followed it to a reviewed result.

- **Before:** a small addition function incorrectly subtracted. All three existing tests failed.
- **During:** Control Center routed the plan, a department head assigned one worker and that worker corrected the function.
- **After:** the verifier recorded all three tests passing against the candidate. The head approved the exact reviewed change.

The original checkout, tracked files and starting revision were unchanged. Delivery remained a separate candidate.

A September 14 record also shows two real read-only project requests running concurrently, each in a different department with a passing head review.

These bounded demonstrations prove those paths. They are not broad reliability or performance benchmarks.

## 11. Local today, Rust next

Keep project registration, team settings and task records on your computer. Use supported installed coding tools through their own accounts.

**Current:** a local browser workspace, compatible command line and one-click macOS launcher for the source checkout.

**Planned:** an installable Rust desktop application. Migration, packaging, signed distribution and independent installation checks are still ahead. macOS is the first target; other operating systems need their own validation.

Ordinary local use requires no separate AI Workforce product account. Coding tools may still send task context to their model providers. Local coordination and storage do not imply offline inference.

## 12. The invitation

**Bring one real task. Keep the whole story together.**

A brief. The right people. The change. The checks. The result.

AI Workforce brings those pieces into one local workspace.

The next product milestone is a repeatable experience that another developer can install and use without the builder’s help.

## Additional implemented capabilities

The current local implementation also includes:

- Local folder browsing and project registration, with separate project settings, state and histories.
- Discovery of supported committed test/check scripts; read-only analysis can run without code-test configuration.
- Bounded planning with named owners, validated dependencies, engine parallel work, recorded peer communication and portable handoff records.
- Frozen admitted worker rosters and saved runtime/model configuration for execution and recovery.
- Independent candidate repositories, private attempt temporary directories and protected coordinator ownership of Git administration.
- Fresh checks of a combined result; individual worker checks alone do not accept combined work.
- Changes, patches, reports, messages, check receipts and unresolved issues available through result details and engine artifacts.
- Persistent request history, phase timing, recorded actual owners and expandable diagnostics.
- Live command-line events, read-only status inspection and per-task views.
- Held queues after server restart, explicit recovery controls and finite repair/retry budgets.
- Duplicate submission protection and checked concurrent workspace edits.
- Native provider sign-in controls through the detected executable.
- Light/dark themes, responsive views, keyboard controls and reduced-motion behavior.
- Optional browser completion/blocker notifications where supported.
- Local loopback serving with request-origin and session checks.
- Startup from the root script, double-click command or local macOS launcher, with reuse of matching running workspaces.

This describes source-backed implementation, including local uncommitted work as of 14 September 2026. Every feature is not independently established by a real-runtime acceptance demonstration.

## Honest boundaries

The Rust app and standalone installer are planned. Signed releases, updates, independent onboarding and repeated everyday use by other developers remain release work.

Full Claude department-head workflow proof and the complete runtime containment suite remain open. Separate repositories and configured write restrictions do not fully confine reads or test processes.

Dirty-work snapshots, automatic candidate application, richer in-flight requirement changes, backup/restore UX and managed desktop background behavior are not complete current features. One request at a time per project remains the workspace default. Automatic work across multiple departments from one brief is not established.

No customer adoption, broad speed advantage, general autonomy or full offline inference is claimed.

## Evidence and sources

- [Master plan, especially section 17](../plan.md): current scope, amendments and open release gates.
- [External MCP to reviewed code candidate](../evidence/issues-mcp-2026-09-13/README.md): actual Codex fixture execution through intake, planning, work, checks and review.
- [Automatic staffing and reviewed analysis](../evidence/automatic-workforce-2026-09-14/README.md): real analysis result, unchanged source and separately labeled scheduler proof.
- [Team refinement and concurrent analysis](../../artifacts/team-refinement/QA.md): two actual read-only requests across departments and projects.
- [Interface and connection verification](../evidence/flight-deck-2026-09-14/README.md): browser and connector checks, distinct from model execution.
- [Local launcher verification](../evidence/run-script-2026-09-14/README.md): cold startup and matching-workspace reuse.
- [Control Center responsibilities](../control-center-flow.md): ownership across intake, assignment, checks and review.
- [Current request and follow-up implementation](../../src/server/requests.ts): bounded prior context and durable request handling.
- [Rust desktop direction](rust-desktop-direction.md): confirmed destination and migration boundaries.

When sharing, retain the **local preview** and **planned Rust app** labels. The HTML presentation is self-contained; these relative evidence links require the repository files beside it.
