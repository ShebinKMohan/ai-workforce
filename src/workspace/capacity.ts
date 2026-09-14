import type { WorkspaceConfig } from '../core/workspace-config.js';

export interface RunCapacity { readonly reservedTurns: number; readonly reservedWriters: number }

/** Static fair reservations are enforced in each child config snapshot. The
 * queue can then count ceilings, including head, repair and fallback turns,
 * without trusting delayed runtime activity events. Unused slots stay reserved. */
export function workspaceRunCapacity(config: WorkspaceConfig): RunCapacity {
  const limits = config.limits;
  const reservedTurns = Math.max(1, Math.min(limits.maxActiveTurns, Math.floor(limits.maxTotalActiveTurns / limits.maxConcurrentProjectRuns)));
  return { reservedTurns, reservedWriters: Math.max(1, Math.min(reservedTurns, limits.maxActiveWriters, Math.floor(limits.maxTotalActiveWriters / limits.maxConcurrentProjectRuns))) };
}

export function globalCapacity(config: WorkspaceConfig | null): RunCapacity {
  return { reservedTurns: config?.limits.maxTotalActiveTurns ?? 2, reservedWriters: config?.limits.maxTotalActiveWriters ?? 2 };
}

export function capacityAvailable(total: RunCapacity, live: ReadonlyArray<RunCapacity>, requested: RunCapacity, intakeTurns = 0): boolean {
  return live.reduce((sum, run) => sum + run.reservedTurns, intakeTurns) + requested.reservedTurns <= total.reservedTurns &&
    live.reduce((sum, run) => sum + run.reservedWriters, 0) + requested.reservedWriters <= total.reservedWriters;
}
