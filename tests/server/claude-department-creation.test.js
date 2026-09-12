import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startOfficeServer } from '../../src/server/index.js';
import { emptyWorkspace } from '../../src/core/workspace-config.js';
import { buildDepartmentOps } from '../../web/claude-office/src/department-manager.js';
import { originFor, rawRequest, tokenFrom } from './support.js';

const values = { name: 'Engineering', color: 'blue', headName: 'Engineering head', runtime: 'codex-local', model: '', instructions: '' };

describe('the original office department form saves an atomic department and head', () => {
  it('allocates safe ids without reusing retired department or agent identities', () => {
    const workspace = emptyWorkspace();
    workspace.retiredIds.departments = ['engineering'];
    workspace.retiredIds.agents = ['engineering-head'];
    const batch = buildDepartmentOps(values, { workspace, revision: 0 });
    expect(batch.departmentId).toBe('engineering-2');
    expect(batch.headId).toBe('engineering-head-2');
    const nonLatin = buildDepartmentOps({ ...values, name: '研发', headName: '主管' }, { workspace, revision: 0 });
    expect(nonLatin.departmentId).toBe('department');
    expect(nonLatin.headId).toBe('head');
    expect(buildDepartmentOps({ ...values, headName: 'Control' }, { workspace, revision: 0 }).headId).toBe('control-2');
  });

  it('creates a department with its read-only head on an empty real server, rejects stale writes, and starts no runtime', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workforce-department-form-'));
    let spawned = 0;
    const server = await startOfficeServer({ port: 0, stateRoot: root, discover: async () => [], spawner: () => { spawned++; throw new Error('Department setup must never start a process'); } });
    try {
      const token = await tokenFrom(server);
      const before = JSON.parse((await rawRequest(server, { path: '/api/workspace' })).body);
      expect(before.workspace.projects).toEqual([]);
      const batch = buildDepartmentOps(values, before);
      const post = (body) => rawRequest(server, { method: 'POST', path: '/api/workspace/ops', headers: { origin: originFor(server), 'x-workforce-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await post({ expectRevision: batch.expectRevision, ops: batch.ops });
      expect(result.status).toBe(200);
      const saved = JSON.parse(result.body);
      expect(saved.revision).toBe(1);
      expect(saved.workspace.projects).toEqual([]);
      expect(saved.workspace.departments).toEqual([expect.objectContaining({ id: batch.departmentId, headAgentId: batch.headId })]);
      expect(saved.workspace.agents).toEqual([expect.objectContaining({ id: batch.headId, departmentId: batch.departmentId, role: 'head', policy: 'analysis', projectIds: [] })]);
      const stale = await post({ expectRevision: 0, ops: buildDepartmentOps({ ...values, name: 'Research', headName: 'Research head' }, before).ops });
      expect(stale.status).toBe(409);
      const invalid = await post({ expectRevision: 1, ops: [{ op: 'department.add', id: 'bad', name: 'Bad', color: 'rose' }, { op: 'agent.add', name: 'Bad head', role: 'head', departmentId: 'bad', runtime: 'codex-local', policy: 'local-development' }] });
      expect(invalid.status).toBe(400);
      const after = JSON.parse((await rawRequest(server, { path: '/api/workspace' })).body);
      expect(after.revision).toBe(1);
      expect(after.workspace.departments).toHaveLength(1);
      expect(after.workspace.agents).toHaveLength(1);
      expect(spawned).toBe(0);
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects duplicate names and unsupported runtime choices before constructing a write', () => {
    const workspace = emptyWorkspace();
    workspace.departments.push({ id: 'engineering', name: 'Engineering', color: 'blue', headAgentId: null, archived: false });
    expect(() => buildDepartmentOps(values, { workspace, revision: 0 })).toThrow(/highlighted/);
    expect(() => buildDepartmentOps({ ...values, name: 'Support', runtime: 'ollama' }, { workspace, revision: 0 })).toThrow(/highlighted/);
  });
});
