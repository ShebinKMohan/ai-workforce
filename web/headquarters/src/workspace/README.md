# Workplace — AI company workspace mockup

A professional interactive UI concept for a company coordinated by AI employees. Open **http://127.0.0.1:4317/src/workspace/index.html** while the local project server is running.

Run from the repository root:

```sh
npm run dev
```

No package installation is required. Existing root-canvas files and settings are unchanged.

## Explore

- **Office:** six miniature department islands, 25 employees including Atlas, clickable desks and department labels, retained zoom, and pauseable communication routes.
- **Organization:** Atlas → six department heads → three specialists per head. The reporting chart scrolls within its panel on smaller desktop widths; mobile stacks explicit department reporting groups.
- **Work board:** queued, in progress, needs review, and done. Open tasks for owner, department, delegation path, description, and review decisions. Status controls are keyboard-accessible native selects.
- **People:** search all 25 employees by name, role, department, or runtime; open individual profiles.
- **Approvals:** approve work or request changes. The board, inspector and approval count share state.
- **Create task:** write an outcome and choose a department; the local task is assigned to its head and appears on the board.

Task data persists in browser local storage under `workplace-mockup-v1`, separate from the original canvas. A sample “New client onboarding” task was created and completed during browser validation. It is local to the validation browser; new browsers start from the seven seeded tasks.

## Scope

This is an interactive UI mockup. The office uses generated 3D-style raster artwork with HTML targets and an animated SVG route layer. Employees remain stationary; there is no 3D camera rotation, live agent execution, actual AI chat, or external invitation. Demo messages explain their scripted behavior. Fonts load from Google Fonts with a system fallback; the UI and office image otherwise run from this repository.

## Developer structure

- `app.js`: app shell, navigation, contextual inspector, local task flows and dialogs.
- `office.js`: office illustration, semantic selection targets, routing and zoom.
- `views.js`: organization, board, and people components, built with DOM APIs.
- `model.js`: department/employee projection, seeded tasks and isolated local persistence.
- `ui.js`: shared icons, avatars, escaping and status display.
- `styles.css`, `views.css`: design tokens, component styles and responsive rules.
- `DESIGN.md`: visual direction, design decisions and reference sources.

The generated concept and final desktop/mobile/organization images are in `artifacts/workplace/` at the project root. Main preview: `artifacts/workplace/desktop.png`.

## Validation

Browser walkthrough used the Codex in-app browser at 1600 × 1000, the normal 1280 × 720 viewport, and 390 × 844 mobile. It covered department selection and team hierarchy, organization navigation, all 25 directory entries including Atlas, search and profile selection, task creation, status changes, approval, reload persistence, chat reopening, pause/play, retained zoom, invitation dialog, mobile drawer navigation and overflow. No relevant browser errors or warnings were recorded. All five new JavaScript modules passed `node --check`.

The final browser rendering was inspected alongside the generated concept using `view_image`. Compared navigation and copy, hierarchy and panel geometry, typography, neutral/sage palette, office artwork, labels, table density, and mobile behavior. Repairs included readable department labels, moving labels away from desks, fitting the complete task summary on desktop, restoring chat reopening, matching department filters, and preserving zoom on selection. Above-the-fold content differences are intentional: actual roster initials and task departments replace generation mistakes, example time labels use “Today,” and the original artwork is framed to fit the available canvas. Controls and text are real HTML rather than a screenshot overlay.
