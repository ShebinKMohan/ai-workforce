/**
 * The generated office floor: one tile per department, one desk per configured
 * agent, and a status word from records only. Payloads are real server
 * documents (tests/workspace-ui/fixtures).
 */
import { describe, expect, it } from 'vitest';
import { floorModel } from '../../web/workspace/src/office/floor-model.js';
import { floorHtml } from '../../web/workspace/src/office/floor.js';
import { indexWorkspace, taskEntries } from '../../web/workspace/src/model.js';
import { clone, fixture } from './support.js';

const allDesks = (model) => model.departments.flatMap((department) => department.desks);

describe('an empty workspace', () => {
  it('draws no tile and no desk, only a disabled "Create a department" until a project has a check', () => {
    const ws = indexWorkspace(fixture('workspace-empty.json'));
    const model = floorModel(ws, fixture('runs-empty.json'), []);
    expect(model.empty).toBe(true);
    expect(model.departments).toEqual([]);
    expect(model.createTile.enabled).toBe(false);
    const html = floorHtml(model);
    expect(html).not.toContain('class="desk ');
    expect(html).toContain('No departments yet');
    expect(html).toContain('aria-disabled="true"');
  });

  it('opens "Create a department" once a project with a check exists', () => {
    const ws = indexWorkspace(fixture('workspace-starter.json'));
    const model = floorModel(ws, fixture('runs-empty.json'), []);
    expect(model.createTile).toMatchObject({ enabled: true, href: '#/departments/new' });
  });
});

describe('a built workspace', () => {
  const workspace = fixture('workspace.json');
  const ws = indexWorkspace(workspace);

  it('has one tile per live department and one desk per live agent, department heads first, archived agents absent', () => {
    const model = floorModel(ws, fixture('runs.json'), []);
    expect(model.departments.map((department) => department.id)).toEqual(['eng', 'design']);
    expect(model.departments[0].desks.map((desk) => desk.agentId)).toEqual(['atlas', 'nova', 'mira', 'bench']);
    expect(model.departments[1].desks.map((desk) => desk.agentId)).toEqual(['vera', 'mo']);
    const live = new Set(ws.liveAgents.map((agent) => agent.id));
    for (const desk of allDesks(model)) expect(live.has(desk.agentId)).toBe(true);
    expect(allDesks(model).some((desk) => desk.agentId === 'old')).toBe(false);
    expect(model.departments[0].desks[0].role).toBe('head');
  });

  it('reads Working only for a part of a live run whose project lock is held', () => {
    const runs = fixture('runs-live.json');
    const model = floorModel(ws, runs, taskEntries(ws, runs, fixture('requests-live.json')));
    const byId = new Map(allDesks(model).map((desk) => [desk.agentId, desk]));
    expect(runs.runs.find((run) => run.state === 'running').projectLock.held).toBe(true);
    expect(byId.get('nova').statusWord).toBe('Working');
    expect(byId.get('nova').href).toMatch(/^#\/tasks\/q\//);
    expect(byId.get('bench').statusWord).toBe('Available');
  });

  it('reads Stalled, never Working, when the same rows sit under a free lock', () => {
    const runs = clone(fixture('runs-live.json'));
    for (const run of runs.runs) run.projectLock = { held: false, pid: null, acquiredAt: null, holder: null };
    const model = floorModel(ws, runs, []);
    const nova = allDesks(model).find((desk) => desk.agentId === 'nova');
    expect(nova.statusWord).toBe('Stalled');
    expect(nova.tone).toBe('failed');
    expect(allDesks(model).some((desk) => desk.statusWord === 'Working')).toBe(false);
  });

  it('never draws green: a verified, settled part reads Available', () => {
    const runs = fixture('runs.json');
    const model = floorModel(ws, runs, taskEntries(ws, runs, fixture('requests.json')));
    expect(runs.runs.some((run) => run.state === 'ready_for_review')).toBe(true);
    expect(allDesks(model).find((desk) => desk.agentId === 'nova').statusWord).toBe('Available');
    for (const desk of allDesks(model)) expect(desk.tone).not.toBe('verified');
    expect(floorHtml(model)).not.toContain('tone-verified');
  });

  it('says when a coding tool is not ready: "Available · Claude Code signed out"', () => {
    const model = floorModel(ws, fixture('runs.json'), []);
    const vera = allDesks(model).find((desk) => desk.agentId === 'vera');
    expect(vera.statusWord).toBe('Available · Claude Code signed out');
    expect(vera.tone).toBe('attention');
  });

  it('marks the project a worker is working in, among its project chips', () => {
    const runs = fixture('runs-live.json');
    const model = floorModel(ws, runs, []);
    const mira = allDesks(model).find((desk) => desk.agentId === 'mira');
    expect(mira.chips.map((chip) => [chip.monogram, chip.active])).toEqual([
      ['ST', true],
      ['DS', false],
    ]);
    expect(allDesks(model).find((desk) => desk.agentId === 'bench').roleLine).toBe('On the bench · no project');
  });

  it('with a project filter keeps department heads of departments with a worker on it, and only those workers', () => {
    const model = floorModel(ws, fixture('runs.json'), [], 'docs-site');
    expect(model.departments.map((department) => department.id)).toEqual(['eng']);
    expect(model.departments[0].desks.map((desk) => desk.agentId)).toEqual(['atlas', 'mira']);
  });

  it('renders desks as decoration and nameplates as links with a full sentence', () => {
    const html = floorHtml(floorModel(ws, fixture('runs-live.json'), []));
    expect(html).toMatch(/<svg class="desk-art"[^>]*aria-hidden="true"/);
    expect(html).toContain('aria-label="Nova, worker in Engineering. Working on');
    expect(html).not.toMatch(/zoom|pan-|animation/i);
  });
});
