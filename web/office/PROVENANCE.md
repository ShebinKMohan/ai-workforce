# Provenance of web/office

**12 September 2026:** `web/office` is retained as historical original artwork and source. `workforce serve` serves `web/workspace` through `src/server/static.ts`. Today's `#/office` retains the user-selected original composition and shell, with a subsequently requested orientation edit: all 24 department desks face the central Coordinator. Its active `office-inward.png` and `office-inward-empty.png` are derivatives of the unchanged original `office-clean.png`, with workspace-derived agent labels, desk occupancy, routing overlays and live controls. It does not serve the old prototype's scripted task data. The copy, rewiring and serving sections below describe the **11 September 2026 snapshot**.

The retained source asset at `web/workspace/public/assets/office-clean.png` was checked against both the retained asset here and the read-only prototype source. All three originals have SHA-256 `9da8e29a1c566422c2238630e227528460010b12721a89b7f41c4f3e2e008035`; that hash does not identify the inward-facing derivatives. Their production record is in [workspace asset provenance](../workspace/ASSET-PROVENANCE.md). The six illustrated islands are physical layout: saved department and agent IDs remain the source of membership, unoccupied seats use the empty artwork and are marked open, and overflow is available in the complete Team list. The central Coordinator is the system scheduler, with no invented model. The reference at `127.0.0.1:4318` remains a static demo; the normal Workforce application and real engine use `127.0.0.1:4317`.

This directory began as a **vendored copy of the user's own original work**, the Agent Office UI, copied into workforce so that `workforce serve` (FR084) can serve it over the coordinator's recorded state. It has since been rewired to that state; this file records both steps.

## 1. The copy

- Source: `/Users/shebin_mohan_k/Documents/ChatGPT/AI Employee System`
- Copied on: 2026-09-11
- Copied files: `index.html`, `src/` (the whole directory), `public/assets/office-clean.png`. Each copied file was re-hashed after the copy and matched its source byte for byte.
- Not copied: `AI-EMPLOYEE-SYSTEM-PLAN.md`, `artifacts/`, `.git/`, `server.mjs`, `package.json`, the source's own Markdown notes at its root, and `.DS_Store` files.
- Source tree digest at the time of the copy (every file under the source, excluding `node_modules` and `.DS_Store`, `.git` included):
  `5ea2a75985ba795c4c3e795f2754293991000e4a9f8903ece98889b003006702` (143 files)
- Digest command, run from the source directory:

  ```sh
  find . -type f -not -path './node_modules/*' -not -name '.DS_Store' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256
  ```

The source repository has no commits, so this digest is the only record of the exact state that was vendored. The source was only ever read, never modified, and its own server was never run. The digest was re-taken after the rewiring below and is unchanged.

## 2. The rewiring (what the pixels mean now)

The illustration, island geometry, seat coordinates, camera, label layout, wires, typography and panel structure are the user's design and are kept. What changed is what they show: everything is now read from the workforce API, and anything the prototype invented is gone.

The illustration file itself is unchanged, but it draws a seated person at all 24 seats. So the page covers the figure at every seat with no configured agent with a veil (`#seat-veils`, drawn by `main.js` from `openSeatVeils` in `office-model.js`), and the image's alt text no longer calls the figures employees.

| File | Now |
| --- | --- |
| `src/data.js` | Scene geometry only: islands, polygons, the 24 drawn seats, the control center. No names, statuses, tasks, runtimes or demo handoffs. |
| `src/office-model.js` (new) | Pure functions: the seat mapping rule, desk state from run/task/attempt/receipt rows, run grouping, evidence tones, runtime status words, event descriptions, pulses. Tested in `tests/office/`. |
| `src/api.js` (new) | Same-origin `fetch` and `EventSource` to `/api/*`; the session token is read from the served meta tag and sent only on the POST routes. |
| `src/main.js` | Seats configured agents (open desks otherwise), derives desks from `/api/runs`, re-reads on `/api/events`, draws pulses only for recorded `coordination.*` events. The demo play button is gone. |
| `src/sidebar.js` | Assign (preview through `POST /api/runs/preview`, then Start run through `POST /api/runs`, with an explicit unconfined-writes consent that defaults off), Tasks (recorded runs with requirements, verifier receipts, the candidate diff and unresolved items), Connections (passive runtime discovery). The canned chat, `responseFor()` and the invented progress array are gone. |
| `src/agent-manager.js` | A read-only directory of the agents in `agents.json`, with details and a "how to add an agent" note. No form, no browser storage. |
| `index.html`, `src/*.css` | Copy that stated demo facts replaced with loading states; styles added for desk tones, open desks, evidence and the assign form. Green is reserved for verifier-accepted work. |

Removed from the copy: `src/agent-store.js` (saved invented agents to browser storage), `src/workspace/` (a separate, entirely scripted mockup that was reachable at `/src/workspace/index.html`), and the two `src/*.test.js` files, which now live, ported to vitest, in `tests/office/` so they run in workforce's suite and are not served.

## Serving differences from the original

`workforce serve` reproduces the original `server.mjs` path mapping (`/` → `index.html`, `/assets/*` → `public/assets/*`, `/src/*` → `src/*`) and adds, at serve time only, one `<meta name="workforce-session-token">` tag to served HTML. The files in this directory are not modified by serving them.
