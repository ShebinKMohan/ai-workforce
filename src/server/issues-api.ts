import { z } from 'zod';
import { CreateIssueSchema, ISSUE_COLUMNS, StartIssueSchema, UpdateIssueSchema, type IssueRecord } from '../issues/contracts.js';
import { IssueStore } from '../issues/store.js';
import { issueView } from '../issues/projection.js';
import { ApiError } from './http.js';
import type { RequestItem, RequestQueue } from './requests.js';
import { invalidBody, readWorkspace } from './workspace-api.js';

/** A board dispatch is an ordinary Control Center submission. This API never spawns. */
export class IssuesApi {
  readonly store: IssueStore;
  private readonly starting = new Map<string, Promise<ReturnType<typeof issueView>>>();
  constructor(private readonly root: string, private readonly queue: Pick<RequestQueue, 'submit' | 'list'>) {
    this.store = new IssueStore(root);
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw invalidBody(result.error.issues, 'the issue');
    return result.data;
  }
  private project(projectId: string, write = false): void {
    const project = readWorkspace(this.root).loaded?.config.projects.find(project => project.id === projectId);
    if (!project) throw new ApiError(404, 'unknown_project', 'Select a saved project for this issue.');
    if (write && project.archived) throw new ApiError(409, 'project_archived', 'Unarchive this project before adding or starting work.');
  }
  private requests(): RequestItem[] { return this.queue.list()['items'] as RequestItem[]; }
  private view(issue: IssueRecord, requests = this.requests()): ReturnType<typeof issueView> {
    const request = issue.dispatch ? requests.find(request => request.clientRequestId === issue.dispatch!.clientRequestId && request.projectId === issue.projectId) ?? null : null;
    if (request && JSON.stringify(issue.dispatch!.request) !== JSON.stringify(request)) this.store.recordRequest(issue.id, request);
    return issueView(issue, this.root, request, this.starting.has(issue.id), requests);
  }
  list(projectId?: string, query?: URLSearchParams) {
    if (projectId !== undefined) this.project(projectId);
    const requests = this.requests();
    const summary = query?.get('summary') === '1';
    const paged = summary || query?.has('after') || query?.has('limit');
    if (!paged) return { ok: true, schemaVersion: 1, columns: ISSUE_COLUMNS, issues: this.store.list(projectId).map(issue => this.view(issue, requests)) };
    const rawLimit = query?.get('limit') ?? '50';
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw new ApiError(400, 'invalid_issue_limit', 'Issue page limit must be between 1 and 100.');
    const after = query?.get('after') ?? undefined;
    if (after !== undefined && !z.string().uuid().safeParse(after).success) throw new ApiError(400, 'invalid_issue_cursor', 'The issue page cursor is invalid.');
    const limit = Number(rawLimit);
    const rows = this.store.list(projectId, { limit: limit + 1, ...(after ? { after } : {}) });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(issue => this.view(issue, requests));
    const issues = summary ? page.map(({ description: _description, ...issue }) => issue) : page;
    return { ok: true, schemaVersion: 1, columns: ISSUE_COLUMNS, issues, hasMore,
      nextCursor: hasMore ? page.at(-1)!.id : null };
  }
  get(id: string) { return { ok: true, issue: this.view(this.store.get(id)) }; }

  async create(raw: unknown) {
    const body = this.parse(CreateIssueSchema, raw);
    this.project(body.projectId, true);
    const saved = this.store.create(body);
    if (!body.start) return { ok: true, issue: this.view(saved) };
    try {
      if (saved.dispatch?.state !== 'submitted' && (saved.title !== body.title || saved.description !== body.description)) {
        throw new ApiError(409, 'issue_changed_after_creation', 'This saved issue was edited after its original creation. Review the current brief and use Start with its current revision. Replaying the original create request did not start changed work.');
      }
      return { ok: true, issue: await this.startIssue(saved.id, { expectRevision: saved.revision, allowUnconfinedWrites: body.allowUnconfinedWrites }) };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // Save the complete brief even when runtime setup or admission refuses its start.
      return { ok: true, issue: this.view(this.store.get(saved.id)), startError: {
        code: error.code, message: error.message, details: error.details, ...error.extra,
      } };
    }
  }
  update(id: string, raw: unknown) {
    const body = this.parse(UpdateIssueSchema, raw);
    return { ok: true, issue: this.view(this.store.update(id, body)) };
  }
  async start(id: string, raw: unknown) {
    const body = this.parse(StartIssueSchema, raw);
    try { return { ok: true, issue: await this.startIssue(id, body) }; }
    catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, error.details,
        { ...error.extra, issue: this.view(this.store.get(id)) });
      throw error;
    }
  }
  private async startIssue(id: string, body: z.infer<typeof StartIssueSchema>): Promise<ReturnType<typeof issueView>> {
    const pending = this.starting.get(id);
    if (pending) return pending;
    const issue = this.store.get(id);
    this.project(issue.projectId, true);
    const claimed = this.store.beginDispatch(id, body);
    if (!claimed.claimed) {
      // An interrupted HTTP reply may leave an intent whose queue receipt is already durable.
      const request = this.requests().find(item => item.clientRequestId === claimed.issue.dispatch!.clientRequestId && item.projectId === issue.projectId);
      if (request) return this.view(this.store.recordRequest(id, request));
      if (claimed.issue.dispatch!.state === 'submitted') return this.view(claimed.issue);
      // Never replay an uncertain intent once queue retention could have removed its receipt.
      throw new ApiError(409, 'issue_dispatch_unconfirmed', 'The issue has a saved dispatch intent but its Control Center receipt is unavailable. Inspect task history before creating replacement work.');
    }
    const dispatch = claimed.issue.dispatch!;
    const work = (async () => {
      try {
        const receipt = await this.queue.submit({ projectId: issue.projectId, task: dispatch.task, mode: 'delegate',
          clientRequestId: dispatch.clientRequestId, allowUnconfinedWrites: dispatch.allowUnconfinedWrites });
        return this.view(this.store.recordRequest(id, receipt));
      } catch (error) {
        const receipt = this.requests().find(item => item.clientRequestId === dispatch.clientRequestId && item.projectId === issue.projectId);
        if (receipt) return this.view(this.store.recordRequest(id, receipt));
        // Validated admission refusals have no execution effect. Unknown failures remain uncertain.
        if (error instanceof ApiError) this.store.recordRefusal(id, error.message);
        throw error;
      }
    })();
    this.starting.set(id, work);
    try { return await work; } finally { this.starting.delete(id); }
  }
}
