import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStateStore } from '../../src/storage/db.js';
import { isWithin, resolveStateRoot } from '../../src/storage/paths.js';
import { LockHeldError } from '../../src/storage/lock.js';
import { projectHasLiveRun, projectStatePaths, projectStateRoot } from '../../src/workspace/paths.js';
import { buildRoster, rosterAgentConfig, rosterContainment, writeRosterSnapshot } from '../../src/workspace/roster.js';
import { build, cleanupAll, refusal, sampleWorkspace, tempDir } from './helpers.js';

afterEach(() => cleanupAll());

describe('roster building', () => {
  it('takes the head and only that department\'s non-archived workers placed on the project', () => {
    const config = sampleWorkspace();
    const payments = buildRoster(config, { projectId: 'checkout', departmentId: 'engineering-payments' });
    expect(payments.head.id).toBe('iris');
    // "old" is archived; nova is on checkout but in another department.
    expect(payments.workers.map((w) => w.id)).toEqual(['probe']);

    const platform = buildRoster(config, { projectId: 'checkout', departmentId: 'engineering-platform' });
    // bench is on no project; forge is on billing.
    expect(platform.workers.map((w) => w.id)).toEqual(['nova']);
    expect(platform.workspaceRevision).toBe(config.revision);
  });

  it('refuses an unknown or archived id, a department with no head and a project nobody is placed on', () => {
    const config = sampleWorkspace();
    const at = (projectId: string, departmentId: string, cfg = config) => refusal(() => buildRoster(cfg, { projectId, departmentId }));
    expect(at('ghost', 'engineering-platform').code).toBe('unknown_project');
    expect(at('checkout', 'marketing').code).toBe('unknown_department');
    expect(at('billing', 'design').code).toBe('department_has_no_head');

    const archived = structuredClone(config);
    archived.projects[0]!.archived = true;
    archived.departments[1]!.archived = true;
    expect(at('checkout', 'engineering-platform', archived).code).toBe('project_archived');
    expect(at('billing', 'engineering-payments', archived).code).toBe('department_archived');

    const nobody = build([{ op: 'project.add', repoPath: '/repos/new' }], config);
    const error = at('new', 'engineering-platform', nobody);
    expect([error.exitCode, error.code]).toEqual([2, 'no_worker_on_project']);
    expect(error.details.join('\n')).toMatch(/worker "bench" is explicitly restricted to: no projects/);
  });

  it('writes a v1 configuration holding only the roster, which resume and fallback then cannot leave', () => {
    const config = sampleWorkspace();
    const roster = buildRoster(config, { projectId: 'billing', departmentId: 'engineering-payments' });
    const v1 = rosterAgentConfig(config, roster);
    expect(v1.agents.map((a) => a.id)).toEqual(['iris', 'probe']);
    expect(Object.keys(v1.runtimes)).toEqual(['claude-local']);
    expect(v1.defaults).toMatchObject({ plannerAgent: 'iris', workerAgent: 'probe', maxTasksPerRun: config.limits.maxTasksPerRun });

    const stateRoot = tempDir();
    const paths = projectStatePaths(stateRoot, 'billing');
    const snapshot = writeRosterSnapshot(paths, roster, v1);
    expect(isWithin(path.join(paths.root, 'rosters'), snapshot.path)).toBe(true);
    expect(readFileSync(snapshot.path, 'utf8')).toBe(snapshot.raw);
    expect((statSync(snapshot.path).mode & 0o777).toString(8)).toBe('600');
    // Content-addressed and written once: the same roster maps to the same file.
    expect(writeRosterSnapshot(paths, roster, v1).path).toBe(snapshot.path);
  });

  it('marks a run exclusive when any roster agent, the head included, runs on a tool without verified write containment', () => {
    const config = sampleWorkspace();
    expect(rosterContainment(config, buildRoster(config, { projectId: 'checkout', departmentId: 'engineering-platform' }))).toEqual({ exclusive: false, unconfinedAgentIds: [] });
    expect(rosterContainment(config, buildRoster(config, { projectId: 'checkout', departmentId: 'engineering-payments' }))).toEqual({ exclusive: true, unconfinedAgentIds: ['iris', 'probe'] });
    // A Codex head with a Claude Code worker: the worker alone makes it exclusive.
    expect(rosterContainment(config, buildRoster(config, { projectId: 'billing', departmentId: 'engineering-platform' }))).toEqual({ exclusive: true, unconfinedAgentIds: ['forge'] });
  });
});

describe('project state roots', () => {
  it('never lets two projects share a database, lock, run directory or candidate workspace path', () => {
    const stateRoot = tempDir();
    const a = projectStatePaths(stateRoot, 'checkout');
    const b = projectStatePaths(stateRoot, 'billing');
    expect(a.root).toBe(path.join(stateRoot, 'projects', 'checkout'));
    for (const key of ['databasePath', 'lockPath', 'runsDir', 'workspaceRoot', 'manifestPath'] as const) {
      expect(a[key]).not.toBe(b[key]);
      expect(isWithin(a.root, a[key])).toBe(true);
      expect(isWithin(b.root, a[key])).toBe(false);
    }
    expect(isWithin(a.root, b.root) || isWithin(b.root, a.root)).toBe(false);
    // And neither is the legacy state root's own database.
    expect(a.databasePath).not.toBe(path.join(resolveStateRoot(stateRoot), 'state.sqlite'));
    expect(() => projectStateRoot(stateRoot, '../escape')).toThrow(/not a valid project id/);
  });

  it('runs two projects under separate locks while the same project queues behind its own', () => {
    const stateRoot = tempDir();
    const a = openStateStore(projectStatePaths(stateRoot, 'checkout'), { mode: 'mutating' });
    try {
      const b = openStateStore(projectStatePaths(stateRoot, 'billing'), { mode: 'mutating' });
      b.close();
      expect(projectHasLiveRun(stateRoot, 'checkout')).toBe(true);
      expect(projectHasLiveRun(stateRoot, 'billing')).toBe(false);
      expect(() => openStateStore(projectStatePaths(stateRoot, 'checkout'), { mode: 'mutating' })).toThrow(LockHeldError);
    } finally {
      a.close();
    }
    expect(projectHasLiveRun(stateRoot, 'checkout')).toBe(false);
    expect(existsSync(path.join(stateRoot, 'state.sqlite'))).toBe(false);
  });
});
