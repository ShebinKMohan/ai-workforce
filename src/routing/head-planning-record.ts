/** Durable input and process receipts for a head interrupted before assignment. */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProcessIdentitySchema, isProcessGroupAlive, matchProcessIdentity } from '../core/process.js';
import { WorkspaceConfigSchema } from '../core/workspace-config.js';
import { findArtifactByPath, readArtifact, writeArtifact } from '../storage/artifacts.js';
import { listEvents } from '../storage/events.js';
import type { StatePaths } from '../storage/paths.js';
import type { HeadPlanningInput } from '../workspace/planning.js';

const RECORD_PATH = 'head/planning-input.json';
const PlanningRecordSchema = z.strictObject({
  planningRecordVersion: z.literal(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  departmentId: z.string().min(1),
  workspace: WorkspaceConfigSchema,
  checkFlags: z.array(z.string().min(1)),
});
export type HeadPlanningRecord = z.infer<typeof PlanningRecordSchema>;

/** Only this request's roster and project survive, never unrelated project context. */
export function recordHeadPlanning(input: HeadPlanningInput, runId: string): void {
  const { roster } = input;
  const departmentWorkspace = { ...input.workspace };
  // Routing is already decided; its global references are outside this frozen roster.
  delete departmentWorkspace.controlCenter;
  const workspace = WorkspaceConfigSchema.parse({
    ...departmentWorkspace,
    runtimes: input.snapshot.config.runtimes,
    projects: [roster.project],
    departments: [roster.department],
    agents: [roster.head, ...roster.workers].map((agent) => ({ ...agent, projectIds: agent.role === 'head' ? [] : [roster.project.id] })),
    retiredIds: { projects: [], departments: [], agents: [] },
  });
  const record = PlanningRecordSchema.parse({ planningRecordVersion: 1, runId, projectId: roster.project.id, departmentId: roster.department.id, workspace, checkFlags: input.checkFlags });
  writeArtifact(input.db, input.paths, {
    runId,
    type: 'head_planning_input',
    relativePath: RECORD_PATH,
    bytes: `${JSON.stringify(record, null, 2)}\n`,
    provenance: { producer: 'headPlanner', note: 'immutable roster and checks for explicit planning resume' },
  });
}

/** Missing means an older/non-head run; missing or corrupt recorded bytes fail closed. */
export function readHeadPlanningRecord(db: DatabaseSync, paths: StatePaths, runId: string): HeadPlanningRecord | null {
  const artifact = findArtifactByPath(db, runId, RECORD_PATH);
  if (artifact === null) return null;
  const record = PlanningRecordSchema.parse(JSON.parse(readArtifact(db, paths, artifact.id).bytes.toString('utf8')));
  if (record.runId !== runId) throw new Error('the head planning snapshot belongs to a different run');
  return record;
}

/** No successor planning session may race a previous unconfirmed process tree. */
export function headPlanningResumeBlocker(db: DatabaseSync, runId: string): string | null {
  const events = listEvents(db, runId);
  const requests = events.filter((event) => event.type === 'head.session_requested');
  for (const request of requests) {
    const opened = events.find((event) => event.sequence > request.sequence && event.type === 'head.session_opened' && event.payload['planningId'] === request.payload['planningId'] && event.payload['attempt'] === request.payload['attempt']);
    if (opened === undefined) {
      return 'a previous head session was requested without a session receipt; its process ownership is uncertain, so no replacement was started';
    }
    const stopped = events.find((event) => event.sequence > opened.sequence && event.type === 'head.session_stopped' && event.payload['sessionId'] === opened.payload['sessionId']);
    if (stopped?.payload['state'] === 'process_tree_terminated') continue;
    const parsed = ProcessIdentitySchema.safeParse(opened.payload['process']);
    if (parsed.success) {
      const state = matchProcessIdentity(parsed.data);
      if ((state === 'dead' || state === 'pid_reused') && !isProcessGroupAlive(parsed.data.pid)) continue;
    }
    return `head session ${String(opened.payload['sessionId'])} has no confirmed stopped process tree; no replacement was started`;
  }
  return null;
}
