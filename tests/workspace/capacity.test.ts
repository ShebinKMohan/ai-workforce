import { describe, expect, it } from 'vitest';
import { emptyWorkspace, WorkspaceLimitsSchema } from '../../src/core/workspace-config.js';
import { workspaceRunCapacity, capacityAvailable } from '../../src/workspace/capacity.js';
import { buildRoster, rosterAgentConfig } from '../../src/workspace/roster.js';
import { parseCliArgs } from '../../src/cli/index.js';
import { sampleWorkspace } from './helpers.js';

describe('global runtime budgets', () => {
  it('allocates one turn and writer per project by default and validates the total can serve all admitted projects', () => {
    expect(workspaceRunCapacity(emptyWorkspace())).toEqual({ reservedTurns: 1, reservedWriters: 1 });
    const legacy = { maxConcurrentProjectRuns: 3 };
    expect(WorkspaceLimitsSchema.parse(legacy)).toMatchObject({ maxTotalActiveTurns: 3, maxTotalActiveWriters: 3 });
    expect(legacy).toEqual({ maxConcurrentProjectRuns: 3 });
    expect(WorkspaceLimitsSchema.safeParse({ maxConcurrentProjectRuns: 3, maxTotalActiveTurns: 2 }).success).toBe(false);
    expect(WorkspaceLimitsSchema.safeParse({ maxConcurrentProjectRuns: 3, maxTotalActiveWriters: null }).success).toBe(false);
    const config = emptyWorkspace(); config.limits = WorkspaceLimitsSchema.parse({ maxConcurrentProjectRuns: 3, maxTotalActiveTurns: 8, maxTotalActiveWriters: 6, maxActiveTurns: 4, maxActiveWriters: 3 });
    expect(workspaceRunCapacity(config)).toEqual({ reservedTurns: 2, reservedWriters: 2 });
  });

  it('freezes lower enforced ceilings into the roster and refuses CLI flags that widen the allocation', () => {
    const config = sampleWorkspace(); const roster = buildRoster(config, { projectId: 'checkout', departmentId: 'engineering-platform' });
    expect(rosterAgentConfig(config, roster).defaults).toMatchObject({ maxActiveTurns: 1, maxActiveWriters: 1 });
    expect(() => rosterAgentConfig(config, roster, { reservedTurns: 2, reservedWriters: 1 })).toThrow(/exceeds/);
    const args = ['run', '--project=checkout', '--department=engineering-platform', '--capacity-turns=1', '--capacity-writers=1'];
    expect(parseCliArgs(args)).toMatchObject({ capacityTurns: 1, capacityWriters: 1 });
    expect(() => parseCliArgs(['run', '--capacity-turns=1', '--capacity-writers=1'])).toThrow(/saved project/);
    expect(() => parseCliArgs(['run', '--project=x', '--department=y', '--capacity-turns=1'])).toThrow(/must both/);
    expect(() => parseCliArgs(['resume', 'run-id', '--capacity-turns=3', '--capacity-writers=3'])).toThrow(/saved project/);
  });

  it('counts an intake turn and every reserved external ceiling before admission', () => {
    const total = { reservedTurns: 2, reservedWriters: 2 };
    expect(capacityAvailable(total, [{ reservedTurns: 1, reservedWriters: 1 }], { reservedTurns: 1, reservedWriters: 1 }, 1)).toBe(false);
    expect(capacityAvailable(total, [{ reservedTurns: 1, reservedWriters: 1 }], { reservedTurns: 1, reservedWriters: 0 })).toBe(true);
    expect(capacityAvailable(total, [{ reservedTurns: 2, reservedWriters: 2 }], { reservedTurns: 1, reservedWriters: 0 })).toBe(false);
    expect(capacityAvailable(total, [{ reservedTurns: 1, reservedWriters: 2 }], { reservedTurns: 1, reservedWriters: 1 })).toBe(false);
  });
});
