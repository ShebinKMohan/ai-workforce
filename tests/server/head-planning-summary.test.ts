import { afterEach, describe, expect, it } from 'vitest';
import { runsDocument } from '../../src/server/read-api.js';
import { appendEvent } from '../../src/storage/events.js';
import { seedRun } from '../coordination/helpers.js';
import { openTempState } from '../helpers/state.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const state = openTempState(); cleanups.push(state.cleanup); const run = seedRun(state.store.db);
  const phase = () => (runsDocument(state.paths, 10)['runs'] as Array<Record<string, any>>).find(row => row['id'] === run.id)!['headPlanning'];
  const append = (type: string, payload: Record<string, unknown>, timestamp = '2026-09-14T06:00:00.000Z') => appendEvent(state.store.db, { runId: run.id, type, payload, timestamp });
  return { state, run, phase, append };
}

describe('current head planning summary', () => {
  it('preserves the actual head while its start is older than a browser event page', () => {
    const f = fixture(); f.append('head.planning_started', { headAgentId: 'head', planningId: 'planning-1', departmentId: 'engineering' });
    for (let n = 0; n < 520; n++) f.append('head.runtime_event', { sequence: n });
    expect(f.phase()).toMatchObject({ headAgentId: 'head', planningId: 'planning-1', departmentId: 'engineering', state: 'running', at: '2026-09-14T06:00:00.000Z', startedAt: '2026-09-14T06:00:00.000Z' });
  });

  it('uses lifecycle sequence and the matching start when clocks move backwards or a head plans again', () => {
    const f = fixture();
    expect(f.phase()).toBeNull();
    f.append('head.planning_started', { headAgentId: 'head', planningId: 'old' }, '2026-09-14T06:02:00.000Z');
    f.append('head.planning_finished', { headAgentId: 'head', outcome: 'planned', taskCount: 2 }, '2026-09-14T06:01:00.000Z');
    expect(f.phase()).toMatchObject({ state: 'planned', taskCount: 2, at: '2026-09-14T06:01:00.000Z', startedAt: '2026-09-14T06:02:00.000Z' });
    f.append('head.planning_started', { headAgentId: 'replacement', planningId: 'new' });
    expect(f.phase()).toMatchObject({ headAgentId: 'replacement', planningId: 'new', state: 'running' });
    f.append('head.planning_finished', { headAgentId: 'replacement', outcome: 'interrupted' });
    expect(f.phase()).toMatchObject({ headAgentId: 'replacement', state: 'interrupted' });
  });

  it('does not invent an owner from malformed planning metadata', () => {
    const f = fixture(); f.append('head.planning_started', { planningId: 'no-owner' });
    expect(f.phase()).toBeNull();
  });
});
