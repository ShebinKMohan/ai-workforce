import { z } from 'zod';
import { McpConnectionError, type OfficeClient } from './client.js';
import { MAX_TASK_CHARS } from '../server/launch.js';
import { IssuePrioritySchema } from '../issues/contracts.js';

const Id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const Key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
  .describe('Stable identifier for this logical mutation. Reuse exactly the same key and arguments after a timeout; use a new key for a new action.');
const Status = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done']);
const Revision = z.number().int().positive();
const Title = z.string().min(1).max(300).regex(/^[^\0]*$/).refine((value) => value.trim().length > 0, 'A nonempty title is required.');
const Description = z.string().max(MAX_TASK_CHARS).regex(/^[^\0]*$/).describe('Complete original issue, plan or PRD text, including acceptance criteria. Preserved without summarizing or truncating; maximum 64,000 characters.');
const Start = z.boolean().default(false).describe('Set true only when the user asked to start execution now. False only saves the issue.');
const Consent = z.boolean().optional().describe('True only if the user explicitly authorized the configured runtime to write without verified containment. Never infer this consent from a request to start work.');
const createFields = {
  projectId: ProjectId, title: Title, description: Description,
  source: z.string().min(1).max(200).optional(), idempotencyKey: Key, start: Start,
  allowUnconfinedWrites: Consent, priority: IssuePrioritySchema.optional(),
};

const definitions = [
  {
    name: 'workforce_list_projects',
    description: 'List registered AI Workforce projects, IDs and readiness. Read only; starts no agents. Use a returned project ID for issues and plans.',
    schema: z.strictObject({}), readOnly: true,
  },
  {
    name: 'workforce_list_issues',
    description: 'Read a bounded page of issue summaries and Kanban columns, including linked execution status. Omit projectId for all projects. Pass returned nextCursor as cursor for the next page; get_issue reads a full description.',
    schema: z.strictObject({ projectId: ProjectId.optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(512).optional() }), readOnly: true,
  },
  {
    name: 'workforce_get_issue',
    description: 'Read one issue, its revision, original description and current execution evidence. Use the current revision when editing or starting.',
    schema: z.strictObject({ issueId: Id }), readOnly: true,
  },
  {
    name: 'workforce_create_issue',
    description: 'Save an issue on a registered project. Execution begins only with explicit start:true, through Control Center and the existing department/head/worker queue. Saving or marking a card Done does not certify verifier acceptance.',
    schema: z.strictObject({ ...createFields, kind: z.enum(['issue', 'plan', 'prd']).default('issue'), status: Status.default('backlog') }), readOnly: false,
  },
  {
    name: 'workforce_submit_plan',
    description: 'Send a complete plan or PRD to a project as one durable Kanban issue. Put the full original document in description. start:true explicitly sends it through Control Center routing, department head planning, workers and verification; otherwise it is saved to Backlog. Returns an issue receipt, not a completion claim.',
    schema: z.strictObject({ ...createFields, kind: z.enum(['plan', 'prd']).default('plan') }), readOnly: false,
  },
  {
    name: 'workforce_update_issue',
    description: 'Edit an issue title, full description, priority or manual Kanban status at the expected revision. Priority remains editable after dispatch. Does not start, stop or steer execution. Linked execution may govern its displayed status. A manual Done card is not proof of verified work.',
    schema: z.strictObject({ issueId: Id, expectRevision: Revision, idempotencyKey: Key, title: Title.optional(), description: Description.optional(), status: Status.optional(), priority: IssuePrioritySchema.optional() }), readOnly: false,
  },
  {
    name: 'workforce_start_issue',
    description: 'Explicitly send a saved issue through Control Center using the same project queue as the app. May spend coding-agent model turns. Repeating this tool with the same idempotencyKey preserves the original submission and returns its current request lineage. Execution retries remain linked to the same issue. Returns receipt/status immediately; use get_issue to inspect completion.',
    schema: z.strictObject({ issueId: Id, expectRevision: Revision, idempotencyKey: Key, allowUnconfinedWrites: Consent }), readOnly: false,
  },
] as const;

export const MCP_TOOLS = definitions.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: z.toJSONSchema(tool.schema, { target: 'draft-7' }),
  annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, idempotentHint: true, openWorldHint: !tool.readOnly },
}));

export class InvalidToolArguments extends Error {}

export async function callWorkforceTool(client: OfficeClient, name: string, value: unknown): Promise<Record<string, unknown>> {
  const tool = definitions.find((item) => item.name === name);
  if (tool === undefined) throw new InvalidToolArguments(`Unknown tool: ${name}`);
  const parsed = tool.schema.safeParse(value);
  if (!parsed.success) throw new InvalidToolArguments(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  const args = parsed.data as Record<string, unknown>;
  if (name === 'workforce_list_projects') {
    const data = await client.read('/api/workspace');
    const workspace = z.looseObject({ projects: z.array(z.record(z.string(), z.unknown())) }).safeParse(data['workspace']);
    if (!workspace.success) throw new McpConnectionError('workspace_unavailable', 'The local workspace cannot be read. Open AI Workforce and resolve its configuration error.', data['error']);
    return { schemaVersion: 1, projects: workspace.data.projects, readiness: data['readiness'], workspaceRevision: data['revision'] };
  }
  if (name === 'workforce_list_issues') {
    const query = new URLSearchParams({ summary: '1', limit: String(args['limit']) });
    if (args['projectId'] !== undefined) query.set('projectId', String(args['projectId']));
    if (args['cursor'] !== undefined) query.set('after', String(args['cursor']));
    return client.read(`/api/issues?${query}`);
  }
  if (name === 'workforce_get_issue') return client.read(`/api/issues/${encodeURIComponent(String(args['issueId']))}`);
  if (name === 'workforce_create_issue' || name === 'workforce_submit_plan') {
    return client.write('/api/issues', { ...args, source: args['source'] ?? 'mcp' });
  }
  const { issueId, ...body } = args;
  if (name === 'workforce_update_issue') {
    if (body['title'] === undefined && body['description'] === undefined && body['status'] === undefined && body['priority'] === undefined) throw new InvalidToolArguments('Provide at least one of title, description, status or priority.');
    return client.write(`/api/issues/${encodeURIComponent(String(issueId))}/update`, body);
  }
  return client.write(`/api/issues/${encodeURIComponent(String(issueId))}/start`, body);
}
