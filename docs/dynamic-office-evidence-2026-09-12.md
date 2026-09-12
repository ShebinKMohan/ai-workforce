# Dynamic office acceptance — 12 September 2026

Scope: WP10b, FR084, FR089, FR090. The saved roster now determines every department floor, head, worker, desk and chair in the primary Office UI. The original Claude shell, directory, settings and task sidebar remain connected to the workspace server. Three.js is vendored with its MIT notice; the scene and furniture code are original.

## Browser acceptance

A separate state root served at `http://127.0.0.1:4420/` was populated through the actual browser forms. It started empty, registered a throwaway project, created two departments and their heads, and added five workers to each department.

- Empty state: one central coordinator, zero departments and employee stations.
- Project registration alone: zero departments, employees and employee stations.
- Department creation: department and its named head persisted together; one room and one station.
- Fifth worker: six stations including the head, all within the same expanded department room. No overflow island.
- Final roster: two rooms, two heads, ten workers and twelve employee stations, preserved after fresh-browser reloads.
- Department selection, employee selection, directory, agent editing, Connections, zoom and fit remain wired. Desktop and 390 × 844 mobile views were inspected.
- Final overview, department, employee, Connections and mobile captures had no overlapping visible label rectangles. Mobile overview reduces labels and reveals employees when their department is selected.
- Final dynamic pages on ports 4317 and 4420 had no browser console warnings or errors.

The actual default workspace on port 4317 was preserved, including Shebin. Its recorded verified Codex task was opened from the new Office sidebar, showing all five stages, independently executed checks and 299 persisted events. The isolated roster walkthrough did not launch a task or model request; its throwaway repository remained unchanged. Existing real-runtime acceptance is documented separately in the earlier day-one evidence.

## Automated validation

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Final complete `npm test`: **1,206 passed, zero failed, 32 skipped** across 106 passing and two skipped files; 51.59 seconds.
- New coverage includes live-only roster mapping, atomic department/head creation and arbitrary-size room layout, including rooms beyond four workers and uneven multi-department layouts.
- An earlier full run under browser/process load had two failures: a short-window worker-overlap assertion and a replay stress-test timeout. Both affected files passed focused reruns without backend or test changes, and the subsequent full run above passed. The original failing log is retained rather than overwritten.
- Idle scenes now stop issuing WebGL draws after the camera settles. Configuration updates, selection, resizing and Connections trigger redraws.

## Reproducible local artifacts

The walkthrough, per-stage workspace and scene receipts, screenshots, final label checks, test logs and a restart launcher are under:

`/Users/shebin_mohan_k/Documents/Workforce-Dynamic-Office-2026-09-12/`

Open `index.html` for the screenshot gallery or `dynamic-office-walkthrough.md` for the stage table and exact demo restart command. The demo server is left running on port 4420 with an isolated state directory. The primary application remains on port 4317.

These results establish the tested local configuration, rendering, navigation and existing task-evidence paths. They do not claim new support for unimplemented runtime adapters, arbitrary fleet performance, or a new paid-model run during this UI walkthrough.
