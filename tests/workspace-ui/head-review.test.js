import { describe, expect, it } from 'vitest';
import { findEntry, taskDetailModel } from '../../web/workspace/src/model.js';
import { renderTask } from '../../web/workspace/src/pages/task.js';
import { contextFor, fixture, uiState, visibleText } from './support.js';

// Extend recorded worker/check fixtures with the department-head review contract.
// The run summary must remain sufficient when a paged event slice omits review.
function reviewTask(state, headReview, { finalReply = null, reviewEvents = [] } = {}) {
  const status = fixture('status-verified.json');
  Object.assign(status.run, { state, headReview, finalReply });
  const runs = fixture('runs.json');
  const run = runs.runs.find(item => item.id === status.run.id);
  Object.assign(run, { state, headReview, finalReply, projectLock: { held: state === 'running', pid: 1, holder: 'alive' } });
  const ctx = contextFor(fixture('workspace.json'), runs, fixture('requests.json'), { ui: uiState({ expanded: new Set(['checks', 'phase:review']) }) });
  const route = { name: 'task', projectId: 'app', runId: status.run.id };
  const entry = findEntry(ctx.entries, route);
  const events = [...fixture('events-verified.json').events, ...reviewEvents];
  const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
  const html = renderTask({ ...ctx, route, taskView: { entry, detail, status, events, loading: false, error: null } });
  return { detail, entry, html, text: visibleText(html) };
}

describe('department-head review on the task evidence page', () => {
  it('shows the real head reviewing after worker checks, even without review events in the slice', () => {
    const { detail, entry, text } = reviewTask('running', { state: 'running', headAgentId: 'atlas', at: '2026-09-12T11:59:00Z' });
    expect(entry.status).toMatchObject({ key: 'headReviewing', tone: 'active' });
    expect(entry.inMotion).toBe(true);
    expect(detail.status.key).toBe('headReviewing');
    expect(detail.phases.find(phase => phase.key === 'check').state).toBe('done');
    expect(detail.phases.find(phase => phase.key === 'review')).toMatchObject({ heading: 'Department-head review', state: 'now' });
    expect(detail.actors.find(actor => actor.role === 'head').line).toBe('Reviewing the result and independent checks.');
    expect(detail.actors.find(actor => actor.role === 'verifier').line).toBe('Finished checking.');
    expect(detail.candidateReviewReady).toBe(false);
    expect(text).toContain('node --version');
    expect(text).not.toContain('Control Center final reply');
    expect(text).not.toContain('Your review');
  });

  it('shows recorded delivery separately from the developer review and preserves check records', () => {
    const { detail, html, text } = reviewTask('ready_for_review', {
      state: 'passed', verdict: 'passed', headAgentId: 'atlas', summary: 'The documentation meets the task.', at: '2026-09-12T11:59:30Z',
    }, { finalReply: 'Documentation is complete. **Both checks passed.**\n\n<img src=x onerror=alert(1)>' });
    expect(detail.phases.find(phase => phase.key === 'review').state).toBe('done');
    expect(detail.verdict).toBe('verified');
    expect(detail.candidateReviewReady).toBe(true);
    expect(text).toContain('Department-head review by Atlas.');
    expect(text).toContain('Control Center final reply');
    expect(text).toContain('Your review');
    expect(text).toContain('your decision to use the result are separate steps');
    expect(text).toContain('node --version');
    expect(html).toContain('<strong>Both checks passed.</strong>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('does not turn accepted worker parts into a verified final result when the head requests changes', () => {
    const { detail, entry, text } = reviewTask('failed', { state: 'changes_requested', verdict: 'changes_requested', headAgentId: 'atlas', summary: 'The search example is missing.', at: '2026-09-12T11:59:30Z' });
    expect(detail.parts.every(part => part.verified)).toBe(true);
    expect(entry.needsYou).toMatchObject({ kind: 'review' });
    expect(detail.status.key).toBe('headReviewChanges');
    expect(detail.verdict).not.toBe('verified');
    expect(detail.phases.find(phase => phase.key === 'review').state).toBe('stopped');
    expect(detail.actors.find(actor => actor.role === 'head').line).toContain('Requested changes');
    expect(detail.finalReply).toBeNull();
    expect(text).toContain('The search example is missing.');
    expect(text).not.toContain('Control Center final reply');
    expect(detail.candidateReviewReady).toBe(false);
  });

  it('keeps recorded work and checks when head review is interrupted, with a resumable review', () => {
    const { detail, text } = reviewTask('interrupted', { state: 'blocked', verdict: 'blocked', headAgentId: 'atlas', summary: 'Review session stopped.', at: '2026-09-12T11:59:30Z' });
    expect(detail.canResume).toBe(true);
    expect(detail.phases.find(phase => phase.key === 'review').state).toBe('stopped');
    expect(detail.actors.find(actor => actor.role === 'head').line).toContain('could not finish');
    expect(text).toContain('The recorded work and checks are preserved.');
    expect(text).not.toContain('Nothing was put together.');
    expect(detail.finalReply).toBeNull();
  });

  it('uses a newer review event while the summary is catching up, and reads a recorded final reply', () => {
    const { detail } = reviewTask('ready_for_review', { state: 'running', headAgentId: 'atlas', at: '2026-09-12T11:59:00Z' }, {
      reviewEvents: [
        { type: 'head.review_finished', sequence: 1001, timestamp: '2026-09-12T11:59:30Z', taskId: null, payload: { headAgentId: 'atlas', verdict: 'passed', summary: 'Documentation checked.' } },
        { type: 'control.final_reply', sequence: 1002, timestamp: '2026-09-12T11:59:31Z', taskId: null, payload: { text: 'Documentation is ready.' } },
      ],
    });
    expect(detail.headReview.state).toBe('passed');
    expect(detail.phases.find(phase => phase.key === 'review').state).toBe('done');
    expect(detail.finalReply).toBe('Documentation is ready.');
  });
});
