import { describe, expect, it } from 'vitest';
import { entryFromStatus, findEntry, taskDetailModel } from '../../web/workspace/src/model.js';
import { renderTask } from '../../web/workspace/src/pages/task.js';
import { checkView } from '../../web/workspace/src/truth.js';
import { clone, contextFor, fixture, uiState, visibleText } from './support.js';

function historicalTask() {
  const status = fixture('status-verified.json');
  const run = fixture('runs.json').runs.find((run) => run.id === status.run.id);
  Object.assign(status, { taskViews: clone(run.taskViews), compromisedReceiptIds: clone(run.compromisedReceiptIds ?? []), outcome: clone(run.outcome ?? null) });
  const ctx = contextFor(fixture('workspace.json'), fixture('runs-empty.json'), fixture('requests-empty.json'), { ui: uiState({ expanded: new Set(['checks', 'phase:check', 'phase:review']) }) });
  const events = fixture('events-verified.json').events;
  const entry = entryFromStatus(ctx.ws, 'app', status, { held: false });
  return { ctx, entry, status, events };
}

describe('task evidence beyond the recent-runs list', () => {
  it('keeps a historical task, its verified parts, and its review action grounded in its own detail evidence', () => {
    const { ctx, entry, status, events } = historicalTask();
    expect(ctx.entries).toEqual([]);
    expect(entry.status.key).toBe('verified');
    expect(entry.needsYou.kind).toBe('review');
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    expect(detail.verdict).toBe('verified');
    expect(detail.parts.every((part) => part.verified)).toBe(true);
    expect(detail.actors.find((actor) => actor.role === 'you').line).toBe('Review the result.');
    const html = renderTask({ ...ctx, taskView: { entry, detail, status, events } });
    expect(visibleText(html)).toContain('Ready for your review');
    expect(visibleText(html)).not.toContain('0 of 2 parts');
  });

  it('prefers fresh detail evidence when a recent-list snapshot still claims passing receipts', () => {
    const { status, events } = historicalTask();
    const ctx = contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'));
    const entry = findEntry(ctx.entries, { projectId: 'app', runId: status.run.id });
    for (const task of status.taskViews) task.receipts.verifierExecutedPassed = 0;
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    expect(entry.status.key).toBe('verified');
    expect(detail.status.key).toBe('unverified');
    expect(detail.verdict).not.toBe('verified');
    expect(detail.parts.some((part) => part.verified)).toBe(false);
  });

  it('does not invent task verification when an older server returns no per-task evidence', () => {
    const { ctx, status, events } = historicalTask();
    delete status.taskViews;
    const entry = entryFromStatus(ctx.ws, 'app', status, { held: false });
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    expect(detail.verdict).not.toBe('verified');
    expect(detail.parts.some((part) => part.verified)).toBe(false);
  });

  it('marks a compromised historical receipt as not counting in both check disclosures and stages', () => {
    const { ctx, entry, status, events } = historicalTask();
    status.compromisedReceiptIds = status.checks.map((check) => check.id);
    for (const task of status.taskViews) task.receipts.verifierExecutedPassed = 0;
    expect(status.requirements).toEqual([]);
    expect(checkView(status.checks[0], status).tone).toBe('compromised');
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    const html = renderTask({ ...ctx, taskView: { entry, detail, status, events } });
    expect(html).not.toContain('tone-verified');
    expect(visibleText(html)).toContain('Does not count');
  });

  it('shows when the task detail could not refresh instead of silently presenting stale records', () => {
    const { ctx, entry, status, events } = historicalTask();
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    const html = renderTask({ ...ctx, taskView: { entry, detail, status, events, error: { message: 'Connection lost' } } });
    expect(visibleText(html)).toContain('Could not refresh this task. Showing the last records this page received.');
  });

  it('removes green check badges when their stored evidence is missing or changed', () => {
    const { ctx, entry, status, events } = historicalTask();
    status.unverifiedReceiptIds = status.checks.map((check) => check.id);
    status.evidenceIssues = ['The saved result does not match its registered hash.'];
    for (const task of status.taskViews) task.receipts.verifierExecutedPassed = 0;
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    const html = renderTask({ ...ctx, taskView: { entry, detail, status, events } });
    expect(html).not.toContain('tone-verified');
    expect(visibleText(html)).toContain('Some saved evidence is missing or has changed.');
    expect(visibleText(html)).toContain('Evidence missing or changed');
  });

  it('keeps valid parts verified while refusing a complete verdict if the combined result evidence is unreadable', () => {
    const { ctx, entry, status, events } = historicalTask();
    status.evidenceIssues = ['Evidence result.json is unavailable.'];
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    expect(detail.parts.every((part) => part.verified)).toBe(true);
    expect(detail.verdict).toBe('unverified');
    expect(detail.status.key).toBe('unverified');
    expect(detail.phases.find((phase) => phase.key === 'review').summary).toContain('complete result is not verified');
  });

  it.each([false, true])('shows stopped planning and Resume even when a final head event is %s', (hasFinishedEvent) => {
    const { ctx, status, events } = historicalTask();
    status.run.state = 'interrupted';
    status.tasks = [];
    status.taskViews = [];
    status.checks = [];
    const planning = events.filter((event) => ['run.created', 'head.planning_started', 'head.session_opened'].includes(event.type));
    if (hasFinishedEvent) {
      const finished = clone(events.find((event) => event.type === 'head.planning_finished'));
      finished.payload.outcome = 'interrupted';
      planning.push(finished);
    }
    const entry = entryFromStatus(ctx.ws, 'app', status, { held: false });
    const staleEntry = { ...entry, run: { ...entry.run, state: 'running', projectLock: { held: true } }, item: { id: 'still-polling', kind: 'request', state: 'running', projectId: 'app', departmentId: entry.departmentId, task: entry.title } };
    const detail = taskDetailModel({ ws: ctx.ws, entry: staleEntry, status, events: planning, now: ctx.now });
    const decide = detail.phases.find((phase) => phase.key === 'decide');
    expect(detail.status.key).toBe('interrupted');
    expect(detail.canResume).toBe(true);
    expect(detail.canStop).toBe(false);
    expect(decide.state).toBe('stopped');
    expect(decide.summary).toContain('stopped while planning');
    expect(decide.summary).not.toContain('is planning');
    expect(detail.actors.find((actor) => actor.role === 'head').line).toBe('Stopped while planning.');
  });

  it('shows the latest successful plan after resuming while retaining the earlier stop in its history', () => {
    const { ctx, entry, status, events } = historicalTask();
    const start = clone(events.find((event) => event.type === 'head.planning_started'));
    const stopped = clone(events.find((event) => event.type === 'head.planning_finished'));
    start.sequence = 0;
    stopped.sequence = 1;
    stopped.payload.outcome = 'interrupted';
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events: [start, stopped, ...events], now: ctx.now });
    const decide = detail.phases.find((phase) => phase.key === 'decide');
    expect(detail.verdict).toBe('verified');
    expect(decide.state).toBe('done');
    expect(decide.summary).toBe('Atlas finished planning.');
    expect(detail.actors.find((actor) => actor.role === 'head').line).toBe('Finished planning: 2 parts.');
    expect(decide.groups.flatMap((group) => group.stages).some((stage) => stage.line === 'Earlier planning stopped. This task was resumed.')).toBe(true);
  });

  it('does not show the previous task evidence while another task is loading', () => {
    const { status, events } = historicalTask();
    const ctx = contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'));
    const interrupted = fixture('status-interrupted.json');
    const entry = findEntry(ctx.entries, { projectId: 'app', runId: interrupted.run.id });
    const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
    expect(detail.status.key).toBe('interrupted');
    expect(detail.verdict).not.toBe('verified');
    expect(detail.record.run).toBe(interrupted.run.id);
    expect(detail.phases.find((phase) => phase.key === 'decide').summary).not.toContain('finished planning');
  });
});
