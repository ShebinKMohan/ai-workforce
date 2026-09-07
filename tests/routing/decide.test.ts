import { describe, expect, it } from 'vitest';
import { decideRoute, extractDeliverables, inferRequiredCapabilities, type RoutingAgent } from '../../src/routing/decide.js';

const worker: RoutingAgent = { id: 'dev', capabilities: ['typescript', 'testing'], policy: 'local-development' };
const planner: RoutingAgent = { id: 'planner', capabilities: ['planning'], policy: 'analysis' };
const reader: RoutingAgent = { id: 'reader', capabilities: ['review'], policy: 'analysis' };

const project = { repoPath: '/repo' };
const limits = { maxTasksPerRun: 10 };
const defaults = { workerAgent: 'dev', plannerAgent: 'planner' };

describe('decideRoute', () => {
  it('routes a single bounded request straight to one worker', () => {
    const decision = decideRoute({
      request: { text: 'Fix the null check in src/core/config.ts so the loader reports a missing file.' },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('direct');
    expect(decision.worker?.agentId).toBe('dev');
    expect(decision.planner).toBeNull();
    expect(decision.reason).toContain('one bounded deliverable');
  });

  it('plans only when several deliverables target distinct parts', () => {
    const decision = decideRoute({
      request: {
        text: ['- Add a rate limiter to src/server/limiter.ts', '- Add the matching client retry in web/client/retry.ts'].join('\n'),
      },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('planned');
    expect(decision.planner).toBe('planner');
    expect(decision.signals.map((s) => s.id)).toContain('distinct_targets');
  });

  it('stays direct when the items name no distinct parts and no interface', () => {
    const decision = decideRoute({
      request: { text: ['- Rename the flag', '- Update the tests'].join('\n') },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('direct');
    expect(decision.reason).toContain('no distinct parts');
  });

  it('plans when two deliverables meet at an explicitly named interface', () => {
    const decision = decideRoute({
      request: {
        text: ['- Build the producer side', '- Build the consumer side', 'Keep the contract between them stable.'].join('\n'),
      },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('planned');
    expect(decision.signals.map((s) => s.id)).toContain('explicit_interface');
    expect(decision.reason).toContain('interface');
  });

  it('stays direct when the request bounds itself to a single change', () => {
    const decision = decideRoute({
      request: { text: ['- Add the header to src/a/one.ts', '- Add the header to src/b/two.ts', 'Just those two lines, nothing else.'].join('\n') },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('direct');
    expect(decision.reason).toContain('single change');
  });

  it('stays direct when no planner agent is configured, and says so', () => {
    const decision = decideRoute({
      request: { text: ['- Add a rate limiter to src/server/limiter.ts', '- Add the client retry in web/client/retry.ts'].join('\n') },
      project,
      agents: [worker],
      limits,
      defaults: { workerAgent: 'dev' },
    });
    expect(decision.path).toBe('direct');
    expect(decision.reason).toContain('no planner agent is configured');
    expect(decision.signals.map((s) => s.id)).toContain('planner_unavailable');
  });

  it('stays direct when the task budget allows one task', () => {
    const decision = decideRoute({
      request: { text: ['- Add a rate limiter to src/server/limiter.ts', '- Add the client retry in web/client/retry.ts'].join('\n') },
      project,
      agents: [worker, planner],
      limits: { maxTasksPerRun: 1 },
      defaults,
    });
    expect(decision.path).toBe('direct');
    expect(decision.reason).toContain('maxTasksPerRun is 1');
  });

  it('honours an operator override to plan', () => {
    const decision = decideRoute({
      request: { text: 'Fix the typo in README.md', forcePath: 'planned' },
      project,
      agents: [worker, planner],
      limits,
      defaults,
    });
    expect(decision.path).toBe('planned');
    expect(decision.reason).toContain('operator');
  });

  it('refuses an override it cannot honour instead of pretending', () => {
    const decision = decideRoute({
      request: { text: 'Fix the typo in README.md', forcePath: 'planned' },
      project,
      agents: [worker],
      limits,
      defaults: { workerAgent: 'dev' },
    });
    expect(decision.path).toBe('direct');
    expect(decision.reason).toContain('no planner agent is configured');
  });

  it('allows an analysis-only agent for a read-only request', () => {
    const decision = decideRoute({
      request: { text: 'Review the run orchestrator and explain its failure modes.' },
      project,
      agents: [reader],
      limits,
      defaults: {},
    });
    expect(decision.worker?.agentId).toBe('reader');
    expect(decision.worker?.writesCandidate).toBe(false);
  });

  it('reports a blocker when only analysis agents exist but the request needs edits', () => {
    const decision = decideRoute({
      request: { text: 'Add a retry to src/net/client.ts' },
      project,
      agents: [reader],
      limits,
      defaults: {},
    });
    expect(decision.worker).toBeNull();
    expect(decision.blocker).toContain('cannot write to the candidate workspace');
  });

  it('reports a blocker when no agents are configured', () => {
    const decision = decideRoute({ request: { text: 'Add a retry.' }, project, agents: [], limits, defaults: {} });
    expect(decision.worker).toBeNull();
    expect(decision.blocker).toContain('no agent is configured');
  });

  it('prefers the configured default worker on a capability tie', () => {
    const other: RoutingAgent = { id: 'other', capabilities: ['typescript', 'testing'], policy: 'local-development' };
    const decision = decideRoute({
      request: { text: 'Add a test for src/core/ids.ts' },
      project,
      agents: [other, worker],
      limits,
      defaults,
    });
    expect(decision.worker?.agentId).toBe('dev');
  });
});

describe('request reading', () => {
  it('extracts enumerated action items', () => {
    expect(extractDeliverables('1. Add the parser\n2. Write the tests\n')).toHaveLength(2);
  });

  it('does not treat a prose sentence as two deliverables', () => {
    expect(extractDeliverables('Add the parser so the loader stops crashing.')).toHaveLength(1);
  });

  it('infers capabilities from the request wording', () => {
    expect(inferRequiredCapabilities('Add a vitest case for src/a.ts')).toEqual(['testing', 'typescript']);
  });
});
