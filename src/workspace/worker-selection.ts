import type { WorkspaceAgent } from '../core/workspace-config.js';

/** Intake suitability hints precede a stable capability match. Availability and
 * explicit scope have already been enforced by the scheduler; this never adds
 * a worker to the admitted roster or grants a stronger execution policy. */
export function rankAvailableWorkers(workers: readonly WorkspaceAgent[], input: {
  task: string; workKind: 'analysis' | 'implementation'; preferredWorkerIds: readonly string[];
}): WorkspaceAgent[] {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []);
  const requested = words(input.task);
  const score = (worker: WorkspaceAgent): number => {
    const preferred = input.preferredWorkerIds.indexOf(worker.id);
    const skills = words(worker.capabilities.join(' '));
    const overlap = [...skills].filter(word => word.length > 2 && requested.has(word)).length;
    const policyFit = input.workKind === 'analysis' ? (worker.policy === 'analysis' ? 2 : 0) : (worker.policy === 'local-development' ? 2 : 0);
    return (preferred < 0 ? 0 : 1000 - preferred * 50) + overlap * 10 + policyFit;
  };
  return workers.map((worker, index) => ({worker,index,score:score(worker)}))
    .sort((a,b) => b.score-a.score || a.index-b.index).map(entry=>entry.worker);
}
