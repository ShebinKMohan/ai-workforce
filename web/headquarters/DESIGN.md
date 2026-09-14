# Workforce interface

The active connected application is `src/headquarters/index.html`. A developer keeps it beside their editor during a long working session, watching task arrivals, reviewing evidence, and sending short briefs to Control Center. The user explicitly prefers VS Code/Cursor-style dark surfaces and clear contrast. The current direction is canvas-first: a spacious, interactive team workspace with floating department summaries and a compact task rail. The user explicitly rejected the previous stack of administrative cards.

## Color and layout

Use editor charcoal for the main surface, a distinct panel gray for the sidebar, brighter neutral text, visible control borders, and blue for primary actions and keyboard focus. Light mode uses crisp white surfaces, dark text, and the same blue action identity. Green means completed work; blue indicates working; amber indicates queued or waiting work; red indicates errors or blockers. Status always includes text.

The app fills the viewport. Headquarters gives the available main area to an explorable office canvas with pan, zoom, fit, and department focus. Compact navigation releases space for the office; it can expand into labeled navigation. Management pages and the right task panel scroll independently. Breadcrumbs navigate to Headquarters or the current parent page. Do not add Recent requests below the organization canvas: the task panel owns that feed.

## Task panel

The default right sidebar shows a live task feed with counted status filters and request cards. Opening a card reveals its conversation, main response, collapsed traces, and real outputs. Back to tasks returns to the feed. A compact composer stays at the bottom with attachments, project, installed runtime, discovered model and effort, and Auto handoff controls. A new feed submission is an independent request; followups inside an opened task retain its context. Submitting new work never silently cancels older work.

## Workspace

Keep the Control Center → department head → agent hierarchy visible through the office arrangement and connections. Use open department areas and individual workstations, with floating summaries rather than nested organization cards. Selecting a person or department opens a contextual inspector without leaving the canvas; editing is a separate explicit action. Do not add stacked page headings and metrics above the office. Use illustrated 2D human avatars with subtle blinking; do not use realistic portraits. Department counters show actual Doing, Next, Done, and waiting states. Accepted task records establish Done. A completed model attempt or a Control Center conversation is not an accepted employee task. Pending briefs may contribute to Next before a worker task exists; avoid double counting once tasks are created. Identify the loaded-history scope rather than implying all-time business metrics.

## Motion

Animate real task arrivals, state changes, and recorded handoffs. Preserve node identity during polling so activity does not restart every refresh. Use short opacity/transform transitions and restrained working LEDs, with reduced-motion support. Never animate invented progress percentages, business KPIs, or simulated agent work as live execution.
