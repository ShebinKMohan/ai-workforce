/**
 * The office's meaning (FR084): who sits where, and what a desk may claim.
 *
 * These replace the prototype's agent-store tests. That store saved invented
 * agents to browser storage; the office now seats the agents the coordinator's
 * configuration defines and derives every desk from recorded rows. The
 * invariants the old tests protected — drawn seats never move, the coordinator
 * keeps its identity, injected or unknown data never becomes a status — are
 * asserted here against fixture API payloads shaped like the real ones.
 */
import { describe, expect, it } from 'vitest';
import { departments, seats } from '../../web/office/src/data.js';
import * as model from '../../web/office/src/office-model.js';
import {
  acceptanceView,
  buildRoster,
  checkView,
  communicationFor,
  departmentCounts,
  departmentFor,
  describeEvent,
  deskState,
  deskTone,
  isVerifiedTask,
  phaseSteps,
  requirementViews,
  runGroup,
  runStatusLine,
  runTone,
  runtimeStatus,
  seatAgents,
  taskOwners,
} from '../../web/office/src/office-model.js';

const scene = { seats, departments };

/** The shape GET /api/office returns for today's ~/.workforce/agents.json. */
const OFFICE = {
  ok: true,
  officeVersion: 1,
  configuration: { found: true, path: '/home/dev/.workforce/agents.json', defaults: { workerAgent: 'engineer-codex', plannerAgent: 'planner' } },
  agents: [
    { id: 'engineer-codex', runtime: 'codex-local', adapter: 'codex', capabilities: ['coding', 'testing'], policy: 'local-development', writeBoundary: { writes: true, requiresAllowUnconfinedWrites: false } },
    { id: 'engineer-claude', runtime: 'claude-local', adapter: 'claude-code', capabilities: ['coding', 'testing'], policy: 'local-development', writeBoundary: { writes: true, requiresAllowUnconfinedWrites: true } },
    { id: 'planner', runtime: 'codex-local', adapter: 'codex', capabilities: ['planning'], policy: 'analysis', writeBoundary: { writes: false, requiresAllowUnconfinedWrites: false } },
  ],
};

const NO_RECEIPTS = { verifierExecutedPassed: 0, verifierExecutedFailed: 0, verifierExecutedOther: 0, otherProvenance: 0 };

function task(overrides = {}) {
  return { id: 't-1', objective: 'Fix the discount rounding', state: 'running', waitReason: null, ownerAgentId: 'engineer-codex', generation: 1, attempt: null, receipts: NO_RECEIPTS, lastEvent: null, ...overrides };
}

function run(overrides = {}, tasks = [task()]) {
  return { id: 'r-1', state: 'running', repoPath: '/repo', createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:01:00.000Z', request: { text: 'Fix the discount rounding' }, taskViews: tasks, eventCount: 12, ...overrides };
}

describe('seating the configured agents', () => {
  it('seats today’s configuration in Engineering, planner at the head, and leaves every other seat an open desk', () => {
    const roster = buildRoster(OFFICE, scene);
    const byId = Object.fromEntries(roster.map((entry) => [entry.id, entry]));
    expect(byId['agent:planner']).toMatchObject({ kind: 'agent', seatId: 'engineering-0', departmentId: 'engineering' });
    expect(byId['agent:engineer-codex']).toMatchObject({ kind: 'agent', seatId: 'engineering-1' });
    expect(byId['agent:engineer-claude']).toMatchObject({ kind: 'agent', seatId: 'engineering-2' });
    expect(byId['seat:engineering-3']).toMatchObject({ kind: 'open', agentId: null, name: 'Open desk' });

    expect(roster).toHaveLength(24);
    expect(roster.filter((entry) => entry.kind === 'open')).toHaveLength(21);
    expect(departmentCounts(roster)).toEqual({ engineering: 3 });
  });

  it('never moves a drawn seat: every entry sits exactly on the illustration’s coordinates', () => {
    const roster = buildRoster(OFFICE, scene);
    for (const seat of seats) {
      const entry = roster.find((candidate) => candidate.seatId === seat.id);
      expect({ x: entry.x, y: entry.y, labelY: entry.labelY }).toEqual({ x: seat.x, y: seat.y, labelY: seat.labelY });
    }
  });

  it('is deterministic, and follows the stated rule for departments, the head seat and overflow', () => {
    expect(seatAgents(OFFICE.agents, scene, OFFICE.configuration.defaults)).toEqual(seatAgents(structuredClone(OFFICE.agents), scene, OFFICE.configuration.defaults));

    expect(departmentFor({ id: 'engineer-codex', capabilities: ['coding'] })).toBe('engineering');
    expect(departmentFor({ id: 'writer', capabilities: ['documentation'] })).toBe('research');
    expect(departmentFor({ id: 'release-bot', capabilities: ['deploy'] })).toBe('operations');
    expect(departmentFor({ id: 'mystery', capabilities: ['something-else'] })).toBe('engineering');

    const many = Array.from({ length: 6 }, (_, index) => ({ id: `coder-${index}`, capabilities: ['coding'], policy: 'local-development' }));
    const { desks, extras } = seatAgents(many, scene, {});
    expect(desks.filter((desk) => desk.departmentId === 'engineering').map((desk) => desk.agentId)).toEqual(['coder-0', 'coder-1', 'coder-2', 'coder-3']);
    expect(extras).toEqual([{ agentId: 'coder-4', departmentId: 'engineering' }, { agentId: 'coder-5', departmentId: 'engineering' }]);
    const roster = buildRoster({ agents: many, configuration: { defaults: {} } }, scene);
    expect(roster.filter((entry) => entry.isCustom).map((entry) => entry.id)).toEqual(['agent:coder-4', 'agent:coder-5']);

    // With no configured planner, the first planning agent heads the table; with none, the first agent.
    const planners = seatAgents([{ id: 'a', capabilities: ['coding'] }, { id: 'b', capabilities: ['planning'] }], scene, {});
    expect(planners.desks.find((desk) => desk.id === 'engineering-0').agentId).toBe('b');
    const noPlanner = seatAgents([{ id: 'a', capabilities: ['coding'] }, { id: 'b', capabilities: ['testing'] }], scene, {});
    expect(noPlanner.desks.find((desk) => desk.id === 'engineering-0').agentId).toBe('a');
  });

  it('shows no agents for a missing or invalid configuration, and ignores entries that are not agents', () => {
    for (const office of [{ agents: [] }, { agents: 'not a list' }, {}, { agents: [null, { name: 'no id' }, 42] }]) {
      const roster = buildRoster(office, scene);
      expect(roster.every((entry) => entry.kind === 'open')).toBe(true);
      expect(departmentCounts(roster)).toEqual({});
    }
  });
});

describe('what a desk may claim', () => {
  it('gives an open desk no status of any kind, whatever the runs say', () => {
    const runs = [run({}, [task({ ownerAgentId: null, attempt: { state: 'running' } })])];
    for (const id of [null, undefined, '']) {
      const desk = deskState(id, runs);
      expect(desk.state).toBe('open');
      expect(deskTone(desk.state)).toBe('open');
    }
  });

  it('says working only while the database holds a running attempt for the agent’s task in a live run', () => {
    expect(deskState('engineer-codex', [run({}, [task({ attempt: null })])]).state).toBe('starting');
    expect(deskState('engineer-codex', [run({}, [task({ attempt: { id: 'a-1', state: 'pending', startedAt: null } })])]).state).toBe('starting');
    const working = deskState('engineer-codex', [run({}, [task({ attempt: { id: 'a-1', state: 'running', startedAt: '2026-09-11T10:00:05.000Z' } })])]);
    expect(working).toMatchObject({ state: 'working', runId: 'r-1', taskId: 't-1' });
    expect(deskTone(working.state)).toBe('active');

    // A task row left `running` in a run that already ended is not live work.
    const stale = deskState('engineer-codex', [run({ state: 'failed' }, [task({ attempt: { state: 'running' } })])]);
    expect(stale.state).not.toBe('working');
    // Another agent's running attempt says nothing about this desk.
    expect(deskState('engineer-claude', [run({}, [task({ attempt: { state: 'running' } })])]).state).toBe('idle');
    expect(deskState('planner', [])).toMatchObject({ state: 'idle' });
  });

  it('never turns green because a runtime said it was done: no verifier receipt, no green', () => {
    // The runtime's own words, as they arrive on the event stream.
    const claims = [
      { type: 'runtime.assistant_message', taskId: 't-1', runId: 'r-1', payload: { text: 'Done! All tests pass and the task is complete.' } },
      { type: 'runtime.turn_completed', taskId: 't-1', runId: 'r-1', payload: { status: 'completed' } },
    ];
    for (const claim of claims) {
      expect(describeEvent(claim)).not.toMatch(/verified|accepted by/i);
      expect(communicationFor(claim, taskOwners([run()]))).toBeNull();
    }

    // The turn ended and the runtime claims success; the verifier is still running checks.
    const verifying = [run({}, [task({ state: 'validating', attempt: { state: 'completed', startedAt: 'x' } })])];
    expect(deskState('engineer-codex', verifying).state).toBe('verifying');
    expect(deskTone(deskState('engineer-codex', verifying).state)).not.toBe('verified');
    expect(runTone(verifying[0])).not.toBe('verified');

    // Accepted, but the only receipt is not verifier-executed.
    const unreceipted = task({ state: 'accepted', attempt: { state: 'completed', startedAt: 'x' }, receipts: { ...NO_RECEIPTS, otherProvenance: 1 } });
    const runs = [run({ state: 'ready_for_review' }, [unreceipted])];
    expect(isVerifiedTask(unreceipted)).toBe(false);
    expect(deskState('engineer-codex', runs).state).toBe('unverified');
    expect(deskTone('unverified')).toBe('warning');
    expect(runTone(runs[0])).toBe('warning');
    expect(phaseSteps(runs[0]).at(-1)).toEqual({ name: 'settled', status: 'failed' });

    // The status document can say `passed` too; without a verifier-executed receipt it is not green.
    const status = {
      run: { state: 'ready_for_review' },
      acceptance: { accepted: true, requiredPassed: 1, requiredTotal: 1, reasons: [] },
      requirements: [{ criterionId: 'tests-pass', status: 'passed', required: true, receiptId: 'c-1', detail: 'passed' }],
      checks: [{ id: 'c-1', outcome: 'passed', exitCode: 0, evidenceProvenance: 'runtime_reported' }],
    };
    expect(requirementViews(status)[0].tone).toBe('warning');
    expect(acceptanceView(status).tone).not.toBe('verified');
  });

  it('turns green only for an accepted task with a passing verifier-executed receipt', () => {
    const verified = task({ state: 'accepted', attempt: { state: 'completed', startedAt: 'x' }, receipts: { ...NO_RECEIPTS, verifierExecutedPassed: 1 } });
    const runs = [run({ state: 'ready_for_review' }, [verified])];
    expect(isVerifiedTask(verified)).toBe(true);
    expect(deskState('engineer-codex', runs)).toMatchObject({ state: 'review', runId: 'r-1' });
    expect(deskTone('review')).toBe('verified');
    expect(runGroup(runs[0])).toBe('review');
    expect(runTone(runs[0])).toBe('verified');
    expect(runStatusLine(runs[0])).toBe('Needs review · 1 of 1 task verified');
    expect(phaseSteps(runs[0]).map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);

    // The real document `workforce status <id> --json` printed for the demo run.
    const status = {
      run: { state: 'ready_for_review' },
      checks: [{ id: '01a0894c-3478', criterionIds: ['cart-tests-pass'], command: 'node --test test/', outcome: 'passed', exitCode: 0, evidenceProvenance: 'verifier_executed' }],
      requirements: [{ criterionId: 'cart-tests-pass', description: 'node --test must pass on the candidate', required: true, status: 'passed', outcome: 'passed', receiptId: '01a0894c-3478', detail: 'passed (exit 0, 78ms)' }],
      acceptance: { accepted: true, requiredTotal: 1, requiredPassed: 1, reasons: [] },
    };
    expect(requirementViews(status)[0]).toMatchObject({ tone: 'verified', label: 'Passed' });
    expect(acceptanceView(status)).toEqual({ tone: 'verified', text: 'Verifier accepted · 1 of 1 required checks passed' });
  });

  it('shows failed and compromised work as exactly that, with a reason', () => {
    const failed = [run({ state: 'failed' }, [task({ state: 'failed', attempt: { state: 'failed', startedAt: 'x' } })])];
    expect(deskState('engineer-codex', failed)).toMatchObject({ state: 'failed', detail: 'task failed' });
    expect(runGroup(failed[0])).toBe('failed');
    expect(runStatusLine(failed[0])).toBe('Failed · no reason recorded');

    const interrupted = [run({ state: 'interrupted' }, [task({ state: 'cancelled' })])];
    expect(deskState('engineer-codex', interrupted).state).toBe('interrupted');

    const status = {
      run: { state: 'failed' },
      acceptance: { accepted: false, requiredPassed: 0, requiredTotal: 1, reasons: ['criterion rewritten'] },
      requirements: [{ criterionId: 'tests-pass', status: 'compromised', required: true, receiptId: 'c-1', detail: 'the candidate rewrote test/cart.test.js' }],
      checks: [{ id: 'c-1', outcome: 'passed', evidenceProvenance: 'verifier_executed' }],
    };
    expect(requirementViews(status)[0]).toMatchObject({ tone: 'compromised', label: 'Compromised' });
    expect(acceptanceView(status)).toMatchObject({ tone: 'compromised' });
  });

  it('has no accepted group and no percentages: only groups a run state supports, and observed phases', () => {
    const states = ['pending', 'running', 'waiting', 'ready_for_review', 'failed', 'cancelled', 'interrupted'];
    expect(new Set(states.map((state) => runGroup({ state })))).toEqual(new Set(['running', 'review', 'failed']));

    const working = run({}, [task({ attempt: { state: 'running', startedAt: 'x' } })]);
    expect(phaseSteps(working)).toEqual([
      { name: 'workspace', status: 'done' },
      { name: 'running', status: 'current' },
      { name: 'verifying', status: 'pending' },
      { name: 'settled', status: 'pending' },
    ]);
    const rendered = JSON.stringify([phaseSteps(working), runStatusLine(working), deskState('engineer-codex', [working])]);
    expect(rendered).not.toMatch(/\d\s*%/);
  });

  it('derives the same office from the same documents, as a reload must', () => {
    const runs = [
      run({ id: 'r-2' }, [task({ id: 't-2', attempt: { state: 'running', startedAt: 'x' } })]),
      run({ id: 'r-1', state: 'ready_for_review' }, [task({ state: 'accepted', receipts: { ...NO_RECEIPTS, verifierExecutedPassed: 1 } })]),
    ];
    const once = OFFICE.agents.map((agent) => deskState(agent.id, runs));
    const again = structuredClone(OFFICE.agents).map((agent) => deskState(agent.id, structuredClone(runs)));
    expect(again).toEqual(once);
    expect(once.map((desk) => desk.state)).toEqual(['working', 'idle', 'idle']);
  });
});

describe('what the office may not overstate', () => {
  const DEAD = { held: false, pid: 2826, acquiredAt: '2026-09-11T10:00:00.000Z', holder: 'dead' };
  const ALIVE = { held: true, pid: 2826, acquiredAt: '2026-09-11T10:00:00.000Z', holder: 'alive' };

  it('never draws a verifier pass green when a requirement says the candidate compromised it', () => {
    const status = {
      run: { state: 'failed' },
      acceptance: { accepted: false, requiredPassed: 0, requiredTotal: 1, reasons: ['criterion "node-tests-pass" passed (exit 0), but the candidate changed the files this criterion executes'] },
      requirements: [{ criterionId: 'node-tests-pass', status: 'compromised', outcome: 'passed', required: true, receiptId: 'c-1', detail: 'passed, but the candidate changed test/pagination.test.js' }],
      checks: [{ id: 'c-1', criterionIds: ['node-tests-pass'], command: 'node --test test/', outcome: 'passed', exitCode: 0, evidenceProvenance: 'verifier_executed' }],
    };
    const view = checkView(status.checks[0], status);
    expect(view.tone).not.toBe('verified');
    expect(view).toMatchObject({ tone: 'compromised', compromised: true, compromisedFor: ['node-tests-pass'] });
    // A planned run's per-task manifests reach the page through the run summary.
    expect(checkView(status.checks[0], { requirements: [] }, { compromisedReceiptIds: ['c-1'] }).tone).toBe('compromised');
    // The same receipt with no compromise recorded is still the verifier's pass.
    expect(checkView(status.checks[0], { requirements: [] }).tone).toBe('verified');
  });

  it('stops showing work as live the moment no coordinator holds the state root, whatever the rows still say', () => {
    const summary = run({}, [task({ attempt: { id: 'a-1', state: 'running', startedAt: '2026-09-11T10:00:05.000Z' } })]);
    expect(deskState('engineer-codex', [summary], ALIVE).state).toBe('working');

    const desk = deskState('engineer-codex', [summary], DEAD);
    expect(desk.state).not.toBe('working');
    expect(desk).toMatchObject({ state: 'stalled', runId: 'r-1', taskId: 't-1' });
    expect(desk.detail).toContain('workforce resume r-1');
    expect(deskTone(desk.state)).toBe('warning');
    expect(runGroup(summary, DEAD)).toBe('stalled');
    expect(runTone(summary, DEAD)).toBe('warning');
    expect(runStatusLine(summary, DEAD)).toMatch(/^Stalled · /);
    expect(phaseSteps(summary, DEAD).map((step) => step.status)).not.toContain('current');
    const status = { run: { state: 'running' }, acceptance: null, requirements: [], checks: [] };
    expect(acceptanceView(status, DEAD)).toMatchObject({ tone: 'warning' });
    expect(acceptanceView(status, DEAD).text).not.toMatch(/Not settled yet/);

    // A lock that could not be read proves nothing either way: no stall is claimed.
    expect(deskState('engineer-codex', [summary], { held: null, holder: 'unreadable' }).state).toBe('working');
    // A stalled run left behind does not hide what the agent did next.
    const later = run({ id: 'r-2', state: 'ready_for_review' }, [task({ id: 't-2', state: 'accepted', receipts: { ...NO_RECEIPTS, verifierExecutedPassed: 1 } })]);
    expect(deskState('engineer-codex', [later, summary], DEAD)).toMatchObject({ state: 'review', runId: 'r-2' });
  });

  it('says why a run failed on the desk and the run row, without opening it', () => {
    const failedTask = task({ state: 'failed', attempt: { state: 'completed', startedAt: 'x' } });
    const compromised = run({ state: 'failed', outcome: { accepted: false, requiredPassed: 0, requiredTotal: 1, compromised: ['node-tests-pass'], failed: [], noEvidence: [], reasons: ['criterion "node-tests-pass" passed, but the candidate changed the files this criterion executes'] } }, [failedTask]);
    expect(runStatusLine(compromised)).toBe('Failed · a criterion is compromised');
    expect(deskState('engineer-codex', [compromised])).toMatchObject({ state: 'failed', label: 'Failed · a criterion is compromised' });
    expect(deskState('engineer-codex', [compromised]).detail).toContain('changed the files');

    const claimedDone = run({ state: 'failed', outcome: { accepted: false, requiredPassed: 0, requiredTotal: 1, compromised: [], failed: ['node-tests-pass'], noEvidence: [], reasons: ['criterion "node-tests-pass" failed with exit 1'] } }, [failedTask]);
    expect(runStatusLine(claimedDone)).toBe('Failed · 0 of 1 required checks passed');
    expect(deskState('engineer-codex', [claimedDone]).label).toBe('Failed · 0 of 1 required checks passed');

    const unexplained = run({ state: 'failed', outcome: null }, [failedTask]);
    expect(runStatusLine(unexplained)).toBe('Failed · no reason recorded');
  });

  it('veils exactly the drawn seats that have no configured agent, so the artwork shows no one who does not exist', () => {
    // The reproduced configuration: an engineer, the planner and a support agent — three agents, 24 drawn seats.
    const office = { agents: [OFFICE.agents[0], OFFICE.agents[2], { id: 'triage-bot', capabilities: ['support'], policy: 'analysis' }], configuration: OFFICE.configuration };
    const roster = buildRoster(office, scene);
    const veils = model.openSeatVeils(roster);
    expect(veils).toHaveLength(21);
    const occupied = new Set(roster.filter((entry) => entry.kind === 'agent').map((entry) => entry.seatId));
    expect(veils.some((veil) => occupied.has(veil.seatId))).toBe(false);
    for (const veil of veils) expect(seats.find((seat) => seat.id === veil.seatId)).toMatchObject({ x: veil.x, y: veil.y });
    expect(model.openSeatVeils(buildRoster({ agents: [] }, scene))).toHaveLength(24);
  });
});

describe('communication pulses and runtimes', () => {
  it('draws a pulse only for a recorded coordination event whose task has a known owner', () => {
    const owners = taskOwners([run()]);
    expect(communicationFor({ type: 'coordination.attached', taskId: 't-1', runId: 'r-1' }, owners)).toMatchObject({ from: 'control', to: 'agent:engineer-codex', type: 'coordination.attached' });
    expect(communicationFor({ type: 'coordination.delivered', taskId: 'unknown', runId: 'r-1' }, owners)).toBeNull();
    for (const type of ['run.created', 'workspace.created', 'runtime.command_exec', 'check.completed', 'run.accepted']) {
      expect(communicationFor({ type, taskId: 't-1', runId: 'r-1' }, owners)).toBeNull();
    }
  });

  it('reports passive discovery in words, a signed-out runtime with its login command, and never as green', () => {
    const base = { adapter: 'codex', displayName: 'Codex CLI', installed: true, adapterSupported: true, controllable: true, version: '0.147.0', loginHint: 'codex login' };
    const signedOut = runtimeStatus({ ...base, auth: 'logged_out', authDetail: '`codex login status` reports no active login' });
    expect(signedOut).toMatchObject({ tone: 'failed', label: 'Signed out' });
    expect(signedOut.detail).toContain('codex login');
    expect(runtimeStatus({ ...base, auth: 'logged_in', authDetail: 'active login' })).toMatchObject({ tone: 'ready', label: 'Signed in' });
    expect(runtimeStatus({ ...base, installed: false, auth: 'unknown', authDetail: 'no executable was found' })).toMatchObject({ label: 'Not installed' });
    expect(runtimeStatus(undefined)).toMatchObject({ label: 'Not reported' });
    for (const status of [signedOut, runtimeStatus({ ...base, auth: 'logged_in' })]) expect(status.tone).not.toBe('verified');
  });
});
