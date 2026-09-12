import { describe, expect, it } from 'vitest';
import { CodexAdapter, CODEX_CAPABILITIES, type RuntimeAdapter, type RuntimeEvent, type SessionInput } from '../../src/adapters/index.js';
import { AdapterError, type StopReceipt } from '../../src/adapters/types.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { controlRoutingExclusive, directControlRoute, routeControlRequest } from '../../src/routing/control-intake.js';
import { build, sampleWorkspace } from '../workspace/helpers.js';

const reports = [{ adapter: 'codex', installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', version: CODEX_CAPABILITIES.write_containment.testedVersion }] as RuntimeReadinessReport[];
const session = { adapter: 'codex' as const, sessionId: 'routing-session', raw: null };
const event = (kind: RuntimeEvent['kind'], payload: Record<string, unknown>): RuntimeEvent => ({ kind, payload, adapter: 'codex', sessionId: session.sessionId, turnId: 'turn-1', sequence: 1, spawnToken: 'test-token', timestamp: new Date().toISOString(), rawRef: 'test:1' });
function stub(output: string, options: { delayOpen?: number; stall?: boolean; unknownStop?: boolean; tool?: boolean } = {}) {
  const calls: string[] = [];
  let input: SessionInput | null = null;
  let prompt = '';
  let release: (() => void) | undefined;
  const adapter = {
    id: 'codex', capabilities: () => new CodexAdapter().capabilities(),
    openSession: async (value: SessionInput) => { calls.push('open'); input = value; if (options.delayOpen) await new Promise((r) => setTimeout(r, options.delayOpen)); return session; },
    startTurn: async (_session: unknown, value: {prompt: string}) => { calls.push('turn'); prompt = value.prompt; return { adapter: 'codex', sessionId: session.sessionId, turnId: 'turn-1', startedAt: new Date().toISOString() }; },
    events: async function* () {
      if (options.stall) await new Promise<void>((resolve) => { release = resolve; });
      if (options.tool) yield event('tool_call', { tool: 'shell' });
      yield event('assistant_message', { text: output });
      yield event('turn_completed', { status: 'completed' });
    },
    stopOwnedProcesses: async () => { calls.push('stop'); release?.(); return { sessionId: session.sessionId, state: options.unknownStop ? 'unknown' : 'process_tree_terminated', processId: null, signal: null, at: new Date().toISOString() }; },
    effectiveSettings: () => ({ model: 'gpt-5.5', effort: 'low' }),
  } as unknown as RuntimeAdapter;
  return { adapter, calls, input: () => input, prompt: () => prompt };
}
const request = () => ({ workspace: sampleWorkspace(), projectId: 'checkout', task: 'Prepare visual design specifications for the project.', reports, allowUnconfinedWrites: false });

describe('Control Center bounded intake', () => {
  it('uses explicit project scopes or directives without a model; a greeting dispatches no work', async () => {
    const input = request();
    input.workspace = build([{ op: 'control-center.set', runtime: 'codex-local', projectRoutes: [{ projectId: 'checkout', departmentId: 'engineering-platform' }] }], input.workspace);
    expect(directControlRoute(input)?.route).toMatchObject({ state: 'selected', method: 'project_rule', departmentId: 'engineering-platform' });
    expect(directControlRoute({ ...input, task: '@design: improve the icon' })?.route).toMatchObject({ method: 'directive', departmentId: 'design' });
    expect(directControlRoute({ ...input, task: '@Engineering improve it' })?.route).toMatchObject({ state: 'blocked', code: 'routing_clarification_required' });
    const hello = await routeControlRequest({ ...input, task: 'Hello!', adapterFactory: () => { throw new Error('greetings must not start a runtime'); } });
    expect(hello.route).toMatchObject({ method: 'direct_reply', departmentId: null });
    expect(hello.reply).toContain('checkout');
  });

  it('classifies against every saved department and preserves a correct team with no head/workers', async () => {
    const model = stub('{"departmentId":"design","reason":"The request concerns visual design."}');
    const ownership: string[] = [];
    const result = await routeControlRequest({ ...request(), adapterFactory: () => model.adapter,
      onSession: () => { expect(model.calls).toEqual(['open']); ownership.push('saved'); },
      onStopped: () => { ownership.push('stopped'); },
    });
    expect(result.route).toMatchObject({ state: 'selected', method: 'classifier', departmentId: 'design', headAgentId: null, model: 'gpt-5.5', effort: 'low', sessionId: 'routing-session' });
    expect(model.calls).toEqual(['open', 'turn', 'stop']);
    expect(ownership).toEqual(['saved', 'stopped']);
    expect(model.input()).toMatchObject({ policy: 'analysis', allowedWritePaths: [] });
    expect(model.input()?.cwd).not.toBe(request().workspace.projects[0]!.repoPath);
    expect(model.prompt()).toContain('engineering-payments');
    expect(model.prompt()).toContain('design');
  });

  it('does not infer department ownership from the sole available worker', async () => {
    expect(directControlRoute(request())).toBeNull();
    const model = stub('{"departmentId":null,"reason":"No finance department is saved.","clarification":"Which department owns the budget review?"}');
    const result = await routeControlRequest({ ...request(), task: 'Review the annual budget.', adapterFactory: () => model.adapter });
    expect(result.route).toMatchObject({ state: 'blocked', code: 'routing_clarification_required', departmentId: null, reason: 'Which department owns the budget review?' });
    expect(model.calls.filter((call) => call === 'turn')).toHaveLength(1);
  });

  it.each(['{"departmentId":"invented","reason":"pick it"}', 'not json', '{"departmentId":"design","reason":"x","execute":"rm -rf"}'])('refuses an invalid routing response %s', async (output) => {
    const model = stub(output);
    const result = await routeControlRequest({ ...request(), adapterFactory: () => model.adapter });
    expect(result.route).toMatchObject({ state: 'blocked', code: 'routing_invalid_response' });
    expect(model.calls).toEqual(['open', 'turn', 'stop']);
  });

  it('times out one stalled turn and confirms owned stop before returning', async () => {
    const model = stub('', { stall: true });
    const result = await routeControlRequest({ ...request(), deadlineMs: 10, adapterFactory: () => model.adapter });
    expect(result.route).toMatchObject({ state: 'blocked', code: 'routing_timeout' });
    expect(model.calls).toEqual(['open', 'turn', 'stop']);
  });

  it('cleans up a session that opens after its deadline without starting a paid turn', async () => {
    const model = stub('', { delayOpen: 30 });
    const result = await routeControlRequest({ ...request(), deadlineMs: 5, adapterFactory: () => model.adapter });
    expect(result.route.code).toBe('routing_timeout');
    expect(model.calls).toEqual(['open', 'stop']);
  });

  it('does not dispatch when a stop receipt is unknown or a tool action is attempted', async () => {
    const uncertain = stub('{"departmentId":"design","reason":"design"}', { unknownStop: true });
    expect((await routeControlRequest({ ...request(), adapterFactory: () => uncertain.adapter })).route.code).toBe('routing_stop_unconfirmed');
    const tool = stub('{"departmentId":"design","reason":"design"}', { tool: true });
    expect((await routeControlRequest({ ...request(), adapterFactory: () => tool.adapter })).route.code).toBe('routing_invalid_action');
  });

  it('uses exact binding readiness and requires consent for an unverified classifier boundary', async () => {
    const input = request();
    input.workspace = build([{ op: 'control-center.set', runtime: 'claude-local' }], input.workspace);
    const claude = [{ ...reports[0], adapter: 'claude-code', version: '2.1.260' }] as RuntimeReadinessReport[];
    expect(controlRoutingExclusive(input.workspace, claude)).toBe(true);
    const result = await routeControlRequest({ ...input, reports: claude });
    expect(result.route.code).toBe('consent_required');
    input.workspace.runtimes['claude-local']!.executable = '/missing/claude';
    expect((await routeControlRequest({ ...input, reports: claude })).route.code).toBe('routing_unavailable');
  });

  it.each(['unknown', 'requested', 'process_tree_terminated'] as const)('retains startup cleanup evidence with state %s before any paid turn', async (state) => {
    const receipt: StopReceipt = { sessionId: 'startup-session', state, processId: 12345, signal: 'SIGTERM', at: new Date().toISOString() };
    const model = stub('');
    model.adapter.openSession = async () => { throw new AdapterError('codex', 'startup_failed', 'Initialization failed.', receipt); };
    const saved: Array<StopReceipt | null> = [];
    const result = await routeControlRequest({ ...request(), adapterFactory: () => model.adapter, onStartupStopped: (value) => saved.push(value) });
    expect(saved).toEqual([receipt]);
    expect(result.route.code).toBe(state === 'process_tree_terminated' ? 'routing_runtime_failed' : 'routing_stop_unconfirmed');
    expect(model.calls).not.toContain('turn');
  });

  it('does not invent unresolved ownership for a proven pre-spawn refusal', async () => {
    const model = stub('');
    model.adapter.openSession = async () => { throw new AdapterError('codex', 'unsupported_setting', 'Unsupported model.'); };
    const saved: Array<StopReceipt | null> = [];
    const result = await routeControlRequest({ ...request(), adapterFactory: () => model.adapter, onStartupStopped: (value) => saved.push(value) });
    expect(saved).toEqual([]);
    expect(result.route.code).toBe('routing_runtime_failed');
    expect(model.calls).not.toContain('turn');
  });
});
