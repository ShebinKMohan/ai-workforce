# Workplace concept

This is a separate, original interface concept at `/src/workspace/index.html`. The existing root canvas, configurations, source files, and artwork remain intact. It follows the generated complete-screen concept in `artifacts/workplace/concept.png`.

## Visual system

Light, neutral, developer-friendly workspace. Ink #252a30; muted text #727b89; border #e7e9ed; surface white; chrome #f7f8fa; sage action #377763. The office asset is rendered without tint or overlay against its native warm-white background. Department colors are identities, while text plus green/amber/gray signals work state.

System sans typography: 29px/650 main title, 17px/650 section titles, 13px/400 body, 12px/500 labels. 8px container radius, 6px controls, 4/8/12/16/24 spacing. Outline SVG icons use a consistent 1.6 stroke. Side navigation 208px, inspector 304px, main region flexible. Panel separation is structural, with no metric card grid.

## Composition and interaction inventory

Brand workplace. Workspace Acme Studio. Sidebar Overview, Work board, People, Approvals; six departments; Settings; Shebin profile. Top bar Workspace / Overview and Prototype. Header Company overview, One workspace. Your entire AI team., Invite teammate, Create task. View tabs Office, Organization, Work board. Office body uses the existing six-island miniature image with semantic department and employee targets, coordinator target, pauseable handoff animation, working/review/available legend and zoom controls. Below it is the In motion task table. Right inspector starts with Atlas, company orchestrator, Message Atlas, six reporting heads, two reviews, and three example activity events.

Organization and People views expose the full 25-person roster. Department selection opens its head and specialists. Board and task inspector share local task state; local creation and status changes persist under a distinct browser key. Modal forms include explicit local preview scope. All user-entered text is escaped.

## Intentional concept corrections

Generated concept's research report was mistakenly tagged Marketing; implementation uses Research. Invented owner initials in the generated table are corrected to the actual roster. Updated timestamps are seeded examples, explicitly qualified by the Prototype/Demo activity state. Invite teammate opens a preview link flow, without sending external invitations. The original image retains physical avatar poses and routes animate between stationary departments. This mockup is a raster 3D illustration with HTML/SVG interactions, not a rotatable WebGL simulation or live workforce.

## References

- https://support.monday.com/hc/en-us/articles/360001267945-The-board-views — alternate views of the same work.
- https://support.monday.com/hc/en-us/articles/360000661379-The-Kanban-View — readable task lifecycle.
- https://multica.ai/docs/squads — leader and member hierarchy with traceable delegation.
- https://multica.ai/docs/agents — distinguish runtime availability from workload.

Built-in Image Gen was used for the full-screen concept, with the existing office image supplied as a composition reference. No third-party application source was copied.
