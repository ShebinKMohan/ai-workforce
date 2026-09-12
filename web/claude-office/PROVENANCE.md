# Dynamic Claude Office — 12 September 2026

The shell originated in the user-selected source at
`/Users/shebin_mohan_k/Documents/ChatGPT/AI Employee System`, previewed separately on port 4318.
The primary engine-backed app on port 4317 serves this directory. Its header, sidebar, employee
focus, directory and settings interactions retain the original Claude design, with additions
for real workspace configuration and task submission.

The current office is an original procedural Three.js scene, implemented in `src/scene-3d.js`,
`src/scene-layout.js`, `src/scene-campus.js` and `src/scene-furniture.js`. The campus module
recreates the selected illustration's rounded pastel islands, stepped central hub and
solid cream walkways. The coordinator uses a curved desk. Floors remain parallel while
individual workstations face inward, and compact nameplates follow the original styling.
The scene replaces the fixed raster scene and the
intermediate inward-facing artwork. The original `public/assets/office-clean.png` is retained
as source history; it is not the active scene background.

A workspace with no departments renders only the central system Coordinator. Registering a
project adds no department or employee. Creating a department saves it and its head together;
each subsequent worker adds a workstation inside that same growing department room. There is
no four-seat limit or fixed set of six department platforms. Saved IDs and roster membership
control the scene; it does not seed sample employees or task activity.

Agents Office and Munder Difflin were interaction/architecture references. No Agents Office
application source or artwork was copied into the procedural scene. Three.js is vendored in
`src/vendor/` with its MIT notice preserved in `src/vendor/THREE-LICENSE.txt`.

`src/live-data.js`, `src/agent-store.js`, `src/department-manager.js` and `src/task-bridge.js`
bind the UI to recorded workspace state, revisioned saves and reviewed task submission through
the existing engine. Task evidence, project setup and the earlier workspace pages remain under
`/workspace/`. The center is the system scheduler, not an additional model agent. The Chat tab
prepares a reviewed task request; it does not fabricate a model conversation.

Browser, test-suite and runtime proof are tracked separately in
[`docs/evidence/workspace/2026-09-12-dogfood.md`](../../docs/evidence/workspace/2026-09-12-dogfood.md).
Earlier browser receipts cover the shell and real task path at their recorded revision; they do
not by themselves establish acceptance of this later dynamic 3D renderer.
