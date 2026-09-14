# AI Workforce: Rust desktop direction

Recorded 14 September 2026 from the owner's explicit request.

The intended product is an installable local Rust application that works with the user's installed coding tools. This replaces the earlier Electron desktop default in the master plan. The current implementation is still Node.js/TypeScript with the Headquarters browser interface. Recording this direction does not mean the conversion has started or that a Rust installer exists.

## What the owner decided

- Move the product toward a Rust application people can install on their own computers.
- Continue working with installed Codex and Claude Code.
- Preserve the product's useful behavior: projects, teams, requests, working copies, checks, review, history and recovery.
- Keep this direction in mind when making future implementation choices.

The desktop framework, migration sequence, release date and whether every screen must also be written in Rust have not been chosen. The request establishes the destination, not a requirement to discard working code immediately.

## Recommended route

First prove a repeatable useful task with another developer. Then make the product easy to install, while moving the engine to Rust in small, checked steps. Rust can be a sensible choice for the application engine; it does not by itself improve the coding models, remove sign-in requirements or make every task faster.

Tauri is one candidate for the desktop window. It supports an existing HTML/CSS/JavaScript interface with a Rust backend, so adopting Rust need not require redesigning Headquarters. Its documentation also describes packaging an existing Node process alongside the app, which could be a temporary migration step. This is a recommendation to evaluate, not an approved framework choice. [Tauri overview](https://v2.tauri.app/start/), [Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/).

| Area | Work needed for the Rust destination |
| --- | --- |
| Desktop window and installation | Bundle the interface and required engine pieces; make open, quit and task stop behave predictably. |
| Installed coding tools | Rebuild or bridge discovery, login status, session control, output reading and cancellation using the same supported interfaces. |
| Task engine | Preserve assignment rules, capacity, waiting reasons, saved requests and the difference between an agent finishing and a checked result. |
| Saved work | Keep existing project, agent, issue and result identities. Test migration on copies and preserve a recoverable backup. |
| Working copies and checks | Carry forward source preservation, stopped-worker checks, independent verification and exact candidate identity. Rust alone is not a sandbox for commands launched by an agent. |
| External connections | Preserve the existing workforce CLI and MCP behavior, or provide an explicit compatibility transition. |
| Everyday use | Test installation on a clean Mac, updates, restart, sleep/wake, missing tools and signed-out accounts. |
| Other operating systems | Validate each platform separately before claiming support. |

## Suggested sequence

1. Write down the behavior the current app must keep and select a small representative task set.
2. Measure the current app's startup, task completion, manual interventions and failures. Use this as a comparison point.
3. Build an installable desktop shell that preserves the familiar interface and existing state.
4. Move one engine area at a time to Rust, checking the same tasks and failure cases after each move. Maintain one clear owner of execution and saved state throughout.
5. Retire the old engine only after the Rust replacement preserves the required behavior and another developer can install and use it without repairs from the author.

No application code, runtime bindings, saved project data or running services are changed by this note. The master plan's independent checks, preservation of user work and release gates continue to apply.
