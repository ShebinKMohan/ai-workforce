# Headquarters fleet redesign — 2026-09-13

Implemented in the connected Headquarters at http://127.0.0.1:4421/.

## Design rationale

The previous desk canvas overlaid department labels and agent names as the team grew. The replacement gives saved people a responsive, conventional layout and makes recorded work the changing visual layer.

- Compact Control Center identity and hierarchy strip.
- A request in focus with current owner and six visible workflow stages. Only a recorded current stage is highlighted; prior stages are not automatically claimed to have passed.
- Agent cards show name, specialty, status and a short current task. Idle cards avoid redundant task copy. Department heads appear first, followed by working/waiting agents.
- Departments collapse independently. The initial preview limits inactive cards, while active/attention agents remain visible. Show more/fewer, department filtering and search cover the entire loaded roster.
- Latest handoff shows its sender and recipient at a glance; expanding it reveals three recent records for the selected request.
- Clicking an agent opens current work and recent communication; instructions, runtime/model and past work are disclosed on demand. Open request links use the existing conversation path.
- DOM updates preserve input, focus, disclosure state and scroll. Motion is restrained and respects reduced motion; avatars do not loop activity animations in the fleet.

Research used the official Multica documentation: [Agents](https://multica.ai/docs/agents), [Squads](https://multica.ai/docs/squads), [Tasks](https://multica.ai/docs/tasks) and [Issues](https://multica.ai/docs/issues). The adopted principles are durable agent identity, explicit task ownership, selective delegation and details on demand. No Multica source or assets were copied, and no comparative speed claim is made.

## Real data and limits

Cards use recorded requests, task ownership, run outcomes and head review. Cancellation overrides stale running task/review rows. Connection loss has an unknown state. A direct conversation answer does not imply engineering checks or review.

The existing read-only run detail response now includes recent durable peer-message identities, delivery states, timestamps and a redacted subject of at most 160 characters. It excludes full message bodies and does not acknowledge or change messages. The response is bounded to 100 recent messages and includes total/truncation metadata. The overview distinguishes recorded, pending delivery, acknowledged, rejected and expired messages.

A browser cache hydrates up to 12 recent/active runs with at most 2 concurrent run reads. It fetches recent event windows (500 rows), retains relevant coordinator/head events and uses summary status as authority. Message delivery refreshes independently every four seconds for active or pending-delivery runs, and every 30 seconds for settled runs while the page is visible. Missing historic ownership stays unknown. The compact overview is a recent activity window, not an exhaustive transcript; request details provide the existing deeper trace view.

## Verification

- `npx vitest run tests/server/fleet-records.test.ts tests/server/fleet-overview.test.ts tests/server/fleet-activity.test.ts tests/server/read-api.test.ts`: 51 passing tests.
- `npm run test:frontend`: 57 passing tests at the shared checkout's current state.
- `npm run typecheck`: passed.
- Browser verification of the real nine-agent workspace at normal, 1440×1000 and 390×844 viewport sizes. At 390px, document scroll width was 390px and the fleet scroll width matched its 334px container.
- Clicked real agents and verified the inspector, idle state and communication empty state. Escape restored focus to the selected agent.
- Separate synthetic fixture with 72 agents across 3 departments: working filter; actual busy/checking cards; work→checks→stopped updates; stopped work moved to history; disconnected status unknown; search found agent 72 beyond the initial preview; 24-member department expanded and collapsed; About agent remained expanded across updates.
- Actual HTTP tests served the new message projection and checked redaction, body omission, read-only behavior, bounded ordering and run isolation. Regression cases also cover resumed requests sharing a run and message acknowledgement without a changed run summary. This is backend behavior proof using controlled records, not a new model-driven team execution.
- Live endpoint checks: UI modules, workspace, requests and run list all returned 200. The workspace remained revision 4 with 9 agents, 1 department, 0 projects, 0 requests and 0 runs.

The Last Ship team and instructions were preserved. No model task, project or simulated activity was inserted into the user's workspace.

## Files

Production files: `live-overview.js/css`, `office-inspector.js/css`, `fleet-activity.js`, `fleet-records.js`, the narrow `live-app.js` integration, and `src/cli/commands/status.ts` for message previews. Existing Issues/Connections work was preserved.

`before/` contains backups of the original overview files. `fixture.html`, `fixture.js` and `serve-fixture.mjs` are an explicitly labeled local layout test harness. To reproduce it from the repository root, run `node docs/evidence/fleet-overview-2026-09-13/serve-fixture.mjs` and open http://127.0.0.1:4432/. It writes no workspace data and starts no model jobs.
