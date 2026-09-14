# Team refinement QA — 14 September 2026

The expanded organization, editable responsibilities, consolidated navigation and portrait
animation passed the checks recorded below. Two real, separately submitted analysis requests
were classified into different departments and ran concurrently, with one worker and one task
per request. Both completed with accepted task records and passing department-head reviews.

This live proof covers small, read-only analysis fixtures. It does not establish code-change
integration, deployment, or automatic cross-department fan-out from a single PRD. Fixture
source stayed clean; accepted analysis records are not evidence of verified code changes.

## Validation

| Check | Result |
| --- | --- |
| Backend regression | 1,938 tests passed; 34 skipped. 175 test files passed; 2 skipped. |
| Frontend regression | 72 tests passed. |
| Typecheck and build | Both passed. |
| Latest browser console | No captured errors or warnings. |
| Six primary pages | Headquarters, Issues, Team, Projects, Connections and Settings visually checked in light and dark themes. |
| Desktop layout | Latest viewport: 1440 × 1000. Headquarters retains five department panels in a 3 + 2 arrangement with matching light/dark geometry. |
| Narrow layout | Native 319 × 863 Headquarters viewport remains readable with no horizontal page or main-content overflow. |

[Visual measurements](./visual-metrics.json) record page/main overflow, theme surfaces and
department geometry. The latest 1440 px Headquarters samples have three approximately
427 × 284 px panels followed by two approximately 647 × 284 px panels in both themes.
All six pages' paired desktop screenshots use 1440 px; the earlier live-work capture uses
1600 px. The task-status sidebar and both 319 px theme samples also passed. All recorded page
and main-content horizontal-overflow checks are false.

## Live department routing and execution

The classifier selected the departments without a manual department override. Full request,
run, task, review and source identities are in [live-flow-proof.json](./live-flow-proof.json).
Times below are UTC on 14 September 2026.

| Fixture project | Classifier route and execution | Recorded interval | Outcome |
| --- | --- | --- | --- |
| `frontend-flow-check` | Frontend & Design → Kara Foster → Will Mason | 05:21:24.205–05:23:38.837 | Exactly one worker/task; task accepted; Kara's review passed; review session stopped; exit 0; source clean. |
| `backend-flow-check` | Backend & Data → Alisha Granderson → Danny Green | 05:21:39.578–05:24:10.612 | Exactly one worker/task; task accepted; Alisha's review passed; review session stopped; exit 0; source clean. |

The intervals overlap for approximately 119.3 seconds. Both fixture source-diff hashes are the
SHA-256 hash of an empty diff. This is observed multi-project concurrency, not a simulated
activity animation. [Headquarters during live work](./headquarters-live-light.png) shows the
recorded ownership and work in the primary view.

## Editing, connections and animation

- The real role editor saved Will Mason's title as **Frontend Developer** while preserving
  his runtime/model/effort binding and selected avatar.
- A final repeat-setup check caught a parser defect: the editor's normal text trim removed
  trailing blank lines after a complete template marker. The repaired parser accepts that
  marker at EOF, retains custom instructions after it and still rejects incomplete blocks.
  The exact saved revision-15 snapshot now produces zero template operations without any
  state repair. A public-HTTP regression covers setup, the title edit and a repeated preview.
- The Codex model disclosure listed six models from the installed runtime's actual catalog.
  Codex and Claude MCP setup was configured, and connection verification reported seven
  tools. Claude's execution account remained signed out; its saved binding was preserved
  and this status stayed distinct from MCP connection readiness.
- Normal portrait animation was observed on frames **0, 1, 2 and 3**. With browser-emulated
  `prefers-reduced-motion: reduce` enabled, all **17 observed avatar elements** remained on
  neutral frame **0**. Emulation was restored afterward. Expressions are decorative and do
  not imply that an agent is working. Offscreen/hidden lifecycle behavior also has automated
  coverage in the avatar-animation tests.

## Design checks

1. A compact toolbar keeps navigation, runtime/MCP status, search and task access available
   without competing with the work area.
2. Six primary navigation destinations consolidate department, request and runtime detail
   within Team, Issues and Connections.
3. Tom Chandler uses the same neutral avatar treatment as the team, without a separate
   oversized colored Control Center banner.
4. Five department groups expose each head, worker specialty and current ownership; the
   desktop layout uses three groups above two wider groups.
5. Light and dark themes share geometry and semantic colors, with paired blue accents
   (`#2967de` light, `#78a7ff` dark) and distinct workspace, panel and input surfaces.

## Screenshot index

| Page | Light | Dark |
| --- | --- | --- |
| Headquarters | [Light](./headquarters-light.png) | [Dark](./headquarters-dark.png) |
| Issues | [Light](./issues-light.png) | [Dark](./issues-dark.png) |
| Team | [Light](./team-light.png) | [Dark](./team-dark.png) |
| Projects | [Light](./projects-light.png) | [Dark](./projects-dark.png) |
| Connections | [Light](./connections-light.png) | [Dark](./connections-dark.png) |
| Settings | [Light](./settings-light.png) | [Dark](./settings-dark.png) |

Additional views: [live Headquarters](./headquarters-live-light.png),
[open task-status sidebar](./headquarters-task-status-light.png),
[319 px Headquarters light](./headquarters-mobile-light.png) and
[319 px Headquarters dark](./headquarters-mobile-dark.png).
