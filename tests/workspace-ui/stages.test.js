/**
 * One task's page model: what each part is doing now, and every recorded stage
 * grouped under the five phases Home teaches. Each case is a real run on the
 * fake runtime: a verified two-part task, a plan the head never got right, a
 * run stopped mid-flight, and a request sent from the page while it ran.
 */
import { describe, expect, it } from 'vitest';
import { findEntry, indexWorkspace, taskDetailModel, taskEntries } from '../../web/workspace/src/model.js';
import { PHASES } from '../../web/workspace/src/words.js';
import { clone, fixture } from './support.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');

function detailFor(name, { runs = fixture('runs.json'), requests = fixture('requests.json'), mutate } = {}) {
  const status = fixture(`status-${name}.json`);
  const events = fixture(`events-${name}.json`).events;
  const ws = indexWorkspace(fixture('workspace.json'));
  const runsDoc = clone(runs);
  if (mutate) mutate(runsDoc);
  const entries = taskEntries(ws, runsDoc, requests);
  const entry = findEntry(entries, { projectId: 'app', runId: status.run.id }) ?? entries.find((candidate) => candidate.runId === status.run.id);
  return { detail: taskDetailModel({ ws, entry, status, events, now: NOW }), entry, events, status };
}

const stagesOf = (detail, key) => detail.phases.find((phase) => phase.key === key).groups.flatMap((group) => group.stages);
const tones = (detail) => detail.phases.flatMap((phase) => phase.groups.flatMap((group) => group.stages.map((stage) => stage.tone)));

describe('the five phases', () => {
  it('use exactly the headings and order of "How a task moves"', () => {
    const { detail } = detailFor('verified');
    expect(detail.phases.map((phase) => [phase.key, phase.heading])).toEqual(PHASES.map((phase) => [phase.key, phase.heading]));
  });

  it('a verified task: every phase done, the head\'s split and assignments recorded, green only where the verifier\'s checks passed', () => {
    const { detail, events } = detailFor('verified');
    expect(detail.phases.map((phase) => phase.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const decide = stagesOf(detail, 'decide').map((stage) => stage.line);
    expect(decide).toContain('Try 1 of 2: Atlas split it into 2 parts. Workforce checked that every part has a worker on Storefront and a clear finish.');
    expect(decide.filter((line) => line.includes('→'))).toEqual(['"Add docs/alpha.md describing the pagination helpers." → Nova. Decided by Atlas.', '"Add docs/beta.md describing the search endpoint." → Mira. Decided by Atlas.']);
    const checks = stagesOf(detail, 'check');
    expect(checks.filter((stage) => stage.id === 'part-result').map((stage) => stage.tone)).toEqual(['verified', 'verified']);
    expect(checks.filter((stage) => stage.id.startsWith('check-')).every((stage) => stage.line.endsWith('run by the verifier.'))).toBe(true);
    expect(detail.verdict).toBe('verified');
    // Every stage line cites the records it came from.
    for (const stage of stagesOf(detail, 'decide')) expect(stage.sourceIds.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'runtime.turn_completed')).toBe(true);
  });

  it('a runtime saying "done" marks nothing: without verifier receipts no part, verdict or result is green', () => {
    const { detail } = detailFor('verified', {
      mutate: (runs) => {
        for (const run of runs.runs) for (const task of run.taskViews) task.receipts = { ...task.receipts, verifierExecutedPassed: 0 };
      },
    });
    // A check row the verifier ran and passed stays green on its own row; nothing built on the part may be.
    const partAndResult = detail.phases.flatMap((phase) => phase.groups.flatMap((group) => group.stages)).filter((stage) => !stage.id.startsWith('check-'));
    expect(partAndResult.map((stage) => stage.tone)).not.toContain('verified');
    expect(detail.verdict).not.toBe('verified');
    expect(stagesOf(detail, 'review')[0].line).toContain('not verified');
    expect(detail.actors.find((actor) => actor.name === 'Nova').line).toContain('no passing check the verifier ran');
  });

  it('a plan never made usable: two returned tries in plain words, nothing assigned, later phases not reached', () => {
    const { detail } = detailFor('rejected');
    expect(detail.phases.map((phase) => phase.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'done']);
    const tries = stagesOf(detail, 'decide').filter((stage) => stage.id.startsWith('try-'));
    expect(tries.map((stage) => stage.line)).toEqual([
      'Try 1 of 2: Workforce returned the plan: part "beta" was given to mo, who is not a worker of Engineering on Storefront. Asking again.',
      'Try 2 of 2: Workforce returned the plan: part "beta" was given to mo, who is not a worker of Engineering on Storefront.',
    ]);
    expect(stagesOf(detail, 'decide').some((stage) => stage.line.includes('→'))).toBe(false);
    expect(detail.status).toMatchObject({ key: 'noPlan', word: 'No usable plan' });
    expect(detail.actors.find((actor) => actor.role === 'head').line).toBe('Did not produce a usable plan.');
    expect(tones(detail)).not.toContain('verified');
  });

  it('a stopped task: the verified part stays verified, the stopped part says so, and Resume is offered', () => {
    const { detail } = detailFor('interrupted');
    expect(detail.status.key).toBe('interrupted');
    expect(detail.canResume).toBe(true);
    expect(detail.canStop).toBe(false);
    expect(detail.actors.find((actor) => actor.name === 'Mira').line).toBe('Stopped before finishing "Add docs/beta.md describing the search endpoint.".');
    expect(detail.actors.find((actor) => actor.name === 'Nova').line).toContain('checks the verifier ran passed');
    expect(stagesOf(detail, 'review')[0]).toMatchObject({ tone: 'attention' });
    expect(stagesOf(detail, 'change').some((stage) => stage.line === 'Stopped before its copy was checked.')).toBe(true);
  });
});

describe('a task while it runs', () => {
  const live = () => detailFor('live', { runs: fixture('runs-live.json'), requests: fixture('requests-live.json') });

  it('expands the current phase with a Now mark, and offers Stop for a task this page started', () => {
    const { detail } = live();
    const now = detail.phases.filter((phase) => phase.state === 'now').map((phase) => phase.key);
    expect(now.length).toBeGreaterThan(0);
    expect(detail.phases.flatMap((phase) => phase.groups.flatMap((group) => group.stages)).some((stage) => stage.mark === 'now')).toBe(true);
    expect(detail.canStop).toBe(true);
    expect(detail.overlay).toBeNull();
  });

  it('under a free lock nothing is Now: the phase reads Stopped, an overlay says Stalled, and Resume is offered', () => {
    const { detail } = detailFor('live', {
      runs: fixture('runs-live.json'),
      requests: fixture('requests.json'),
      mutate: (runs) => {
        for (const run of runs.runs) run.projectLock = { held: false, pid: null, acquiredAt: null, holder: null };
      },
    });
    expect(detail.phases.some((phase) => phase.state === 'now')).toBe(false);
    expect(detail.phases.some((phase) => phase.state === 'stopped')).toBe(true);
    expect(detail.overlay?.kind).toBe('stalled');
    expect(detail.status.key).toBe('stalled');
    expect(detail.canResume).toBe(true);
    expect(detail.actors.filter((actor) => actor.role === 'worker').some((actor) => actor.line.startsWith('Working'))).toBe(false);
  });
});

describe('a task that has not started', () => {
  it('a queued request shows its plain waiting reason in phase 1, and the department head has not seen it', () => {
    const ws = indexWorkspace(fixture('workspace.json'));
    const entries = taskEntries(ws, fixture('runs-live.json'), fixture('requests-queued.json'));
    const queued = entries.find((entry) => entry.item?.state === 'queued');
    expect(queued.status).toMatchObject({ key: 'waiting', line: 'Another task is running on Storefront.' });
    const detail = taskDetailModel({ ws, entry: queued, status: null, events: [], now: NOW });
    expect(detail.phases.map((phase) => phase.state)).toEqual(['now', 'not_yet', 'not_yet', 'not_yet', 'not_yet']);
    expect(detail.actors.find((actor) => actor.role === 'head').line).toBe('Has not seen the task yet.');
  });

  it('a held request is a Needs you item with Start and Discard that cannot be hidden', () => {
    const ws = indexWorkspace(fixture('workspace.json'));
    const held = taskEntries(ws, fixture('runs-live.json'), fixture('requests-held.json')).find((entry) => entry.item?.state === 'held');
    expect(held.needsYou).toMatchObject({ kind: 'held', hideable: false, actions: ['start', 'discard'] });
    expect(held.needsYou.requestId).toBe(held.item.id);
  });
});
