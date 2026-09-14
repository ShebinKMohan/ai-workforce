# Headquarters frontend

This frontend is part of the consolidated AI Workforce repository. Run `npm start` from the
repository root, or from this folder, to open **http://127.0.0.1:4421/**. The existing backend
serves all application files and APIs; a second server is not required.

The active page is `src/headquarters/index.html`. See the root `README.md` and
`docs/mcp.md` for current startup, project issues and external coding-agent connections.
The original standalone proxy, prototypes and historical evidence are retained below for provenance.

---

# Agent Office canvas

A working, local UI prototype based on the supplied office reference. Six departments retain their original relative positions around a central coordinator. Each department has four stationary seated specialists; the coordinator is the 25th employee. The illustration contains desks, computers, chairs, and people, without plants, whiteboards, or walking figures.

## Run

Requires a modern Node.js installation. There are no package dependencies to install.

```sh
npm run dev
```

Open http://127.0.0.1:4317. The server binds only to the local loopback interface. Set `PORT` if 4317 is already in use.

## Interactions

- Drag the canvas with a mouse or one finger to pan. Trackpad scrolling also pans.
- Pinch, or hold Control/Command while scrolling, to zoom. The plus/minus controls provide the same operation.
- Click a department to focus it, up to 150% of overview on desktop. Click a desk or employee label to focus that employee, up to 220%. Compact screens use a closer focus, constrained by the available viewport.
- Use the fit button, `0`, or `Home` to return to the office. Arrow keys pan when the canvas has focus. `Escape` also resets the scope and closes the mobile chat drawer.
- Department headings and full employee names remain visible at every viewport width, including when Control Center is selected. The overview uses compact name-only plates; focused teams reveal roles. Nameplates adjust their spacing after zoom/resize to avoid overlaps without moving any employee. A short leader connects displaced labels to their original anchors. The coordinator is named Atlas by default, and the Agents directory also lists every name.
- The control center opens the contextual Chat panel. Selecting a department or employee scopes the conversation to that target.
- Play the handoff preview to see small communication packets move between stationary agents and departments. Pause stops the sequence. Reduced-motion settings show static route highlights.
- The runtime dock and Connections view show example mappings: Codex / GPT-5.5, Claude Code / Claude Sonnet, and a local Qwen3 endpoint. These are illustrative choices, not detected or connected runtimes.
- Chat accepts messages and displays deterministic local demo responses. The last 30 messages are retained in browser local storage. Task review controls update in-memory demo state and reset on reload.

## Create and configure agents

Use **Add agent** in the header or the sidebar to create an agent. Use **Agents** for the searchable roster, then **Edit agent** to modify any specialist or the coordinator.

Configure full name, role, department, provider, custom provider name, exact model ID, runtime, and instructions. Advanced settings support an optional endpoint, credential environment-variable name (not an API key), and optional temperature. Providers include OpenAI, Anthropic, Google, Ollama, and custom providers. Runtimes include Codex CLI, Claude Code, Ollama, and direct model APIs. Model text is editable and suggestions are examples, not live discovery.

Configurations persist in browser local storage under `agent-office-config-v1`. Failed writes leave both the previous configuration and the form draft intact. New agents appear at additional canvas desks grouped by department, update department/office counts and runtime mappings, and are included in contextual chat. They start without a task or a running model session. The original 24 specialist seats are preserved. Existing specialist departments remain fixed; new agents can change departments. Use **Show additional desks** from a department view or **Find on canvas** in the directory to navigate to new agents.

## Implementation boundary

This is a UI prototype. It does not invoke an AI model, discover installed CLIs, execute work, stream real agent events, or perform external approvals. There is no backend workforce implementation in this workspace.

The office is a generated raster illustration with HTML interaction targets, an SVG communication layer, and a 2D pan/zoom camera. It does not provide 3D camera rotation or individually movable furniture. The user explicitly requested stationary employees.

## Source

- `src/main.js`: semantic labels, selection, route overlays, communication packets, and panel coordination.
- `src/camera.js`: mouse/touch pan, anchored zoom, focus animation, keyboard controls, resize behavior, and bounds.
- `src/sidebar.js` and `src/sidebar.css`: contextual chat, local sample tasks, review flow, and runtime mappings.
- `src/agent-store.js`: validated, atomic configuration persistence and derived provider/runtime mappings.
- `src/agent-manager.js` and `src/agent-manager.css`: search, creation, editing and validation forms.
- `src/extra-desks.js`: stationary desks for newly configured agents in an expandable canvas wing.
- `src/data.js`: six departments, 24 specialists, the coordinator position, and example runtime mappings.
- `public/assets/office-clean.png`: simplified office artwork, produced with the built-in image-generation tool.
- `artifacts/office-ui-preview.png`: complete desktop screenshot, including the labels and chat sidebar.
- `artifacts/office-illustration-prompt.md`: exact artwork generation prompt.

The pre-existing planning and assessment documents are preserved. This implementation is original and does not copy the inspected third-party office application's source.

## Verification

`npm run check` validates module syntax. Browser verification covered department and employee focus, label hit targets, mouse drag, trackpad pan, pinch zoom events, click suppression after a drag, keyboard reset, stationary employee coordinates during communications, chat input and escaping, local conversation persistence, synchronized review counts, model/runtime details, and the responsive chat drawer. See `artifacts/verification.md` for the scope of these checks.

Agent configuration verification: `npm test` runs persistence, validation, and label-spacing tests. Browser checks cover creation, editing, moving a new agent to another department, cancel, reload restoration, coordinator renaming, full-name visibility, updated counts/mappings, no invented tasks, and the mobile directory/form.
