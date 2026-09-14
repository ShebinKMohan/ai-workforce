import { z } from 'zod';
import { SLUG_PATTERN } from '../core/workspace-config.js';
import { MAX_TASK_CHARS } from '../server/launch.js';
import { RequestItemSchema } from '../server/requests.js';

export const ISSUE_COLUMNS = [
  { id: 'backlog', label: 'Backlog' }, { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' }, { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' }, { id: 'cancelled', label: 'Canceled' },
] as const;
export const IssueStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export const IssuePrioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;
const title = z.string().max(300).refine(value => value.trim().length > 0 && !value.includes('\0'), 'A nonempty title without NUL characters is required.');
const description = z.string().max(MAX_TASK_CHARS).refine(value => !value.includes('\0'), 'Description cannot contain NUL characters.');
export const IdempotencyKeySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const CreateIssueSchema = z.strictObject({
  projectId: z.string().max(64).regex(SLUG_PATTERN), title, description: description.default(''),
  kind: z.enum(['issue', 'plan', 'prd']).default('issue'),
  source: z.string().min(1).max(200).refine(value => !value.includes('\0')).default('workspace'),
  status: IssueStatusSchema.default('backlog'), priority: IssuePrioritySchema.default('none'), idempotencyKey: IdempotencyKeySchema,
  start: z.boolean().default(false), allowUnconfinedWrites: z.boolean().default(false),
});
export const UpdateIssueSchema = z.strictObject({
  expectRevision: z.number().int().positive(), title: title.optional(), description: description.optional(),
  status: IssueStatusSchema.optional(), priority: IssuePrioritySchema.optional(), idempotencyKey: IdempotencyKeySchema.optional(),
}).refine(value => value.title !== undefined || value.description !== undefined || value.status !== undefined || value.priority !== undefined, 'Supply a title, description, status, or priority change.');
export const StartIssueSchema = z.strictObject({
  expectRevision: z.number().int().positive(), allowUnconfinedWrites: z.boolean().default(false),
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export const IssueRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().uuid(), projectId: z.string().regex(SLUG_PATTERN),
  revision: z.number().int().positive(), title, description,
  kind: z.enum(['issue', 'plan', 'prd']), source: z.string(), manualStatus: IssueStatusSchema,
  priority: IssuePrioritySchema.default('none'),
  createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().nullable().default(null),
  dispatch: z.strictObject({
    clientRequestId: z.string(), task: z.string(), allowUnconfinedWrites: z.boolean(),
    startedAt: z.string(), state: z.enum(['pending', 'submitted', 'refused']),
    request: RequestItemSchema.nullable(), retryRequest: RequestItemSchema.nullable().default(null), retryConflict: z.string().nullable().default(null), error: z.string().nullable(),
  }).nullable(),
});
export type IssueRecord = z.infer<typeof IssueRecordSchema>;
export type CreateIssue = z.infer<typeof CreateIssueSchema>;
export type UpdateIssue = z.infer<typeof UpdateIssueSchema>;
export type StartIssue = z.infer<typeof StartIssueSchema>;

/** Keep both user fields intact when wrapping the brief for Control Center. */
export function issueTask(input: Pick<IssueRecord, 'title' | 'description'>): string {
  return input.description.length ? `${input.title}\n\n${input.description}` : input.title;
}
