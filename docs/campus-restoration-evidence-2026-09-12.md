# Claude campus geometry restoration — 12 September 2026

WP10b / FR089 / FR090. The earlier dynamic renderer preserved functionality but lost the selected Claude illustration's department shapes, platform alignment and physical paths. This change restores those aspects while retaining the saved-roster contract.

The source reference is the user's `Documents/ChatGPT/AI Employee System/public/assets/office-clean.png`, with placement and label styling in that project's `src/data.js` and `src/styles.css`. The new campus geometry is original Three.js code; the reference image is not a fixed background and no sample department records are imported.

The scene now uses parallel rounded department islands, muted pastel tops with shaded vertical sides, a distinct stepped sage control hub, a curved three-monitor desk and cream bridges meeting the floor edges. Furniture faces inward independently of floor orientation. Rooms expand around every configured employee. Six initial campus positions match the reference arrangement; additional departments use outer rings with bridges that avoid unrelated floors. Per-workspace browser preferences retain department slots through edits and reloads.

## Validation

- Typecheck and build passed.
- Complete suite: **1,210 passed, zero failures, 32 skipped**; 52.54 seconds.
- Sixteen layout tests cover empty state, fifth/twenty-fifth workers, rotated workstation containment, parallel floors, persistent slots and thirty connected departments with no bridge crossing unrelated floors.
- Actual saved workspace on port 4420: two rooms, twelve employee desks/avatars and two physical bridges; reload and department/employee selection passed.
- The user's current workspace on port 4421: Engineering, Finance and Sales, three heads and three bridges. These user-created records were read without mutation.
- Separate, explicitly labeled browser-only fixtures exercised zero departments/bridges and six departments/twenty-four employee stations/six bridges. These were never persisted or represented as real runtime activity.
- Seven final browser captures, after the last framing and persistence changes: zero overlapping visible nameplates, zero browser errors, zero API mutations. Bridge ends visibly meet the shaped islands. The existing servers remain running.

The original artwork, comparison gallery, screenshots and structured browser receipts are preserved in `/Users/shebin_mohan_k/Documents/Workforce-Dynamic-Office-2026-09-12/` as `campus-comparison.html`, `campus-browser-walkthrough.md`, `campus-all-acceptance.json` and `campus-label-checks.json`. This is visual and interaction evidence; no new model task was launched for this correction.
