import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './support.js';
import { applyLiveDocuments, control, departments, employees, loadLiveData, projects, runtimes, snapshot } from '../../web/claude-office/src/live-data.js';

const emptyRuns = () => fixture('runs-empty.json');
const emptyRequests = () => fixture('requests-empty.json');
function company(workerCount = 0, head = true) {
  const doc = fixture('workspace-starter.json');
  doc.workspace.runtimes = { local: { adapter: 'codex', model: 'configured-runtime-model' } };
  doc.workspace.departments = [{ id: 'actual-team', name: 'Actual team', color: 'blue', headAgentId: head ? 'actual-head' : null, archived: false }];
  doc.workspace.agents = [
    ...(head ? [{ id: 'actual-head', name: 'Actual head', role: 'head', departmentId: 'actual-team', runtime: 'local', instructions: 'Actual planning instructions', projectIds: [], archived: false }] : []),
    ...Array.from({ length: workerCount }, (_, i) => ({ id: `actual-worker-${i}`, name: `Worker ${i}`, role: 'worker', departmentId: 'actual-team', runtime: 'local', projectIds: ['storefront'], instructions: `Actual worker ${i}`, archived: false })),
  ];
  return doc;
}
const apply = (doc) => applyLiveDocuments(doc, emptyRuns(), emptyRequests());
afterEach(() => vi.unstubAllGlobals());

describe('original Office adapter reads only actual workspace entities', () => {
  it('empty API workspace has no departments, employees, tasks or invented control model', () => {
    apply(fixture('workspace-empty.json'));
    expect(departments).toEqual([]);
    expect(employees).toEqual([]);
    expect(projects).toEqual([]);
    expect(snapshot().tasks).toEqual([]);
    expect(control).toMatchObject({ id: 'control', name: 'System scheduler', model: '', runtime: '' });
    expect(runtimes.every((runtime) => !runtime.configured)).toBe(true);
    apply({ ok: true, exists: false, workspace: null });
    expect(departments).toEqual([]);
    expect(employees).toEqual([]);
  });

  it('adding only a project never accepts the suggested starter as saved agents', () => {
    const doc = fixture('workspace-starter.json');
    expect(doc.suggestedStarter.workers.length).toBeGreaterThan(0);
    apply(doc);
    expect(projects).toHaveLength(1);
    expect(departments).toEqual([]);
    expect(employees).toEqual([]);
  });

  it.each([0, 1, 5, 25])('retains exactly one head and %i actual workers with no geometric seat limit', (count) => {
    apply(company(count));
    expect(departments.map((item) => item.id)).toEqual(['actual-team']);
    expect(employees).toHaveLength(count + 1);
    expect(new Set(employees.map((item) => item.id)).size).toBe(count + 1);
    expect(departments[0].employees).toEqual(employees.map((item) => item.id));
    expect(employees.every((item) => item.departmentId === 'actual-team' && item.configured && !item.template)).toBe(true);
    expect(employees[0]).toMatchObject({ id: 'actual-head', role: 'Department head', workspaceRole: 'head', model: 'configured-runtime-model', instructions: 'Actual planning instructions' });
    expect(employees.every((item) => !Object.hasOwn(item, 'seatId') && !Object.hasOwn(item, 'avatar'))).toBe(true);
    expect(employees.every((item) => item.task === '' && item.status !== 'working')).toBe(true);
    expect(runtimes.find((runtime) => runtime.id === 'local').model).toBe('configured-runtime-model');
  });

  it('renders a real department with no head or workers', () => {
    apply(company(0, false));
    expect(departments).toHaveLength(1);
    expect(departments[0]).toMatchObject({ id: 'actual-team', employees: [], summary: 'no department head · 0 workers' });
    expect(employees).toEqual([]);
  });

  it('removes archived people and departments, preserving live stable IDs and renderer coordinates', () => {
    const doc = company(25);
    apply(doc);
    const departmentArray = departments;
    const employeeArray = employees;
    const head = employees[0];
    head.x = 42;
    const room = departments[0];
    room.y = 17;
    const next = structuredClone(doc);
    next.workspace.agents[1].archived = true;
    next.workspace.agents[0].name = 'Renamed real head';
    next.workspace.agents[0].model = 'agent-model';
    apply(next);
    expect(departments).toBe(departmentArray);
    expect(employees).toBe(employeeArray);
    expect(departments[0]).toBe(room);
    expect(departments[0].y).toBe(17);
    expect(employees[0]).toBe(head);
    expect(head).toMatchObject({ name: 'Renamed real head', model: 'agent-model', x: 42 });
    expect(employees).toHaveLength(25);
    expect(employees.some((item) => item.id === 'actual-worker-0')).toBe(false);
    next.workspace.departments[0].archived = true;
    apply(next);
    expect(departments).toEqual([]);
    expect(employees).toEqual([]);
  });

  it('retains every actual department beyond six without synthesizing template IDs', () => {
    const doc = company(0, false);
    doc.workspace.departments = Array.from({ length: 9 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}`, archived: false }));
    apply(doc);
    expect(departments.map((item) => item.id)).toEqual(doc.workspace.departments.map((item) => item.id));
    expect(employees).toEqual([]);
  });

  it('preserves the last complete workspace during network and malformed-payload failures', async () => {
    const doc = company(1);
    apply(doc);
    const before = snapshot();
    const head = employees[0];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable'); }));
    const failed = await loadLiveData();
    expect(failed.error).toBe('network unavailable');
    expect(failed.workspaceDoc).toBe(before.workspaceDoc);
    expect(failed.updatedAt).toBe(before.updatedAt);
    expect(employees[0]).toBe(head);
    expect(departments).toHaveLength(1);
    expect(employees).toHaveLength(2);
    const broken = structuredClone(doc);
    broken.workspace.agents = [null];
    expect(() => apply(broken)).toThrow();
    expect(snapshot().workspaceDoc).toBe(doc);
    expect(employees[0]).toBe(head);
  });
});
