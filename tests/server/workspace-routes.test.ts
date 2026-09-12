/**
 * The workspace routes of `workforce serve`: every write needs this server's
 * Origin, its session token and a JSON body; a change is compare-and-swap on
 * the revision the page saw; an invalid change writes nothing; and reading the
 * workspace, or looking at a folder, never writes anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../src/server/index.js';
import { workspaceFilePath } from '../../src/workspace/paths.js';
import { cleanupAll, gitRepo, registerCleanup, tempDir } from '../workspace/helpers.js';
import { cleanupAll as cleanupFixtures, useFixture, writeFakeAgentsConfig } from '../workspaces/support.js';
import { originFor, rawRequest, tokenFrom, type RawResponse } from './support.js';

afterEach(() => {
  cleanupAll();
  cleanupFixtures();
  vi.unstubAllEnvs();
});

interface Office {
  readonly server: OfficeServer;
  readonly token: string;
  readonly stateRoot: string;
  readonly spawns: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
}

async function office(extra: Partial<OfficeServerOptions> = {}): Promise<Office> {
  const stateRoot = extra.stateRoot ?? path.join(tempDir('workforce-serve-ws-'), 'state');
  const spawns: Office['spawns'] = [];
  const server = await startOfficeServer({
    port: 0,
    discover: async () => [],
    spawner: (command, args, options) => {
      spawns.push({ command, args, options });
      throw new Error('no process may be started by these requests');
    },
    ...extra,
    stateRoot,
  });
  registerCleanup(() => void server.close());
  return { server, token: await tokenFrom(server), stateRoot, spawns };
}

function post(target: Office, route: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return rawRequest(target.server, {
    method: 'POST',
    path: route,
    headers: { origin: originFor(target.server), 'x-workforce-token': target.token, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function json(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

function report(adapter: 'codex' | 'claude-code', usable: boolean): RuntimeReadinessReport {
  return {
    adapter,
    displayName: adapter === 'codex' ? 'Codex' : 'Claude Code',
    installed: usable,
    adapterSupported: true,
    controllable: true,
    auth: usable ? 'logged_in' : 'unknown',
    authDetail: 'test report',
    readiness: usable ? 'ready' : 'not_installed',
    version: null,
    checkedAt: new Date().toISOString(),
  } as unknown as RuntimeReadinessReport;
}

const WRITE_ROUTES = [
  '/api/workspace/ops',
  '/api/workspace/ops/project.add',
  '/api/projects/inspect',
  '/api/requests',
  '/api/requests/0190aaaa-request/start',
  '/api/requests/0190aaaa-request/discard',
  '/api/requests/0190aaaa-request/stop',
  '/api/projects/checkout/runs/0190aaaa-run/stop',
  '/api/projects/checkout/runs/0190aaaa-run/resume',
];

describe('reading the workspace', () => {
  it('is the empty workspace at revision 0 on a fresh state root, and reading writes nothing', async () => {
    const target = await office();
    const document = json(await rawRequest(target.server, { path: '/api/workspace' }));
    expect(document).toMatchObject({
      ok: true,
      exists: false,
      revision: 0,
      error: null,
      workspace: { projects: [], departments: [], agents: [] },
      readiness: { empty: true },
      suggestedStarter: null,
    });
    expect(document.readiness.steps.map((step: { id: string }) => step.id)).toEqual(['tools', 'project', 'department', 'send']);
    expect(json(await rawRequest(target.server, { path: '/api/requests' }))).toMatchObject({ ok: true, items: [], live: [] });
    expect(json(await rawRequest(target.server, { path: '/api/runs' }))).toMatchObject({ mode: 'legacy', runs: [], earlierHistory: null });
    expect(existsSync(target.stateRoot)).toBe(false);
  });

  it('reports a workspace file it cannot read, with its issues, and leaves the file exactly as it is', async () => {
    const stateRoot = tempDir('workforce-serve-ws-bad-');
    writeFileSync(workspaceFilePath(stateRoot), '{"schemaVersion": 2, "projects": "not a list"');
    const before = readFileSync(workspaceFilePath(stateRoot));
    const target = await office({ stateRoot });
    const document = json(await rawRequest(target.server, { path: '/api/workspace' }));
    expect(document).toMatchObject({ ok: true, exists: true, workspace: null, revision: null, error: { code: 'invalid_workspace' } });
    const change = await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'department.add', name: 'Engineering' }] });
    expect(change.status).toBe(400);
    expect(json(change).error.code).toBe('invalid_workspace');
    expect(readFileSync(workspaceFilePath(stateRoot))).toEqual(before);
  });
});

describe('every write route needs all three proofs and a valid body', () => {
  it('refuses a foreign Origin, a missing Origin, a missing token, a wrong token and a non-JSON body, and changes nothing', async () => {
    const target = await office();
    const body = JSON.stringify({ expectRevision: 0, ops: [{ op: 'department.add', name: 'Engineering' }] });
    const cases: Array<{ headers: Record<string, string>; status: number; code: string }> = [
      { headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-workforce-token': target.token }, status: 403, code: 'origin_rejected' },
      { headers: { 'content-type': 'application/json', 'x-workforce-token': target.token }, status: 403, code: 'origin_required' },
      { headers: { 'content-type': 'application/json', origin: originFor(target.server) }, status: 403, code: 'token_required' },
      { headers: { 'content-type': 'application/json', origin: originFor(target.server), 'x-workforce-token': 'f'.repeat(target.token.length) }, status: 403, code: 'token_rejected' },
      { headers: { 'content-type': 'text/plain', origin: originFor(target.server), 'x-workforce-token': target.token }, status: 415, code: 'content_type_rejected' },
    ];
    for (const route of WRITE_ROUTES) {
      for (const entry of cases) {
        const response = await rawRequest(target.server, { method: 'POST', path: route, headers: entry.headers, body });
        expect({ route, status: response.status, code: json(response).error.code }).toEqual({ route, status: entry.status, code: entry.code });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
    expect(existsSync(target.stateRoot)).toBe(false);
    expect(target.spawns).toHaveLength(0);
  });

  it('refuses a body that is not JSON, or has fields the route does not take, on every write route', async () => {
    const target = await office();
    for (const route of WRITE_ROUTES) {
      const notJson = await post(target, route, 'this is not json');
      expect({ route, status: notJson.status, code: json(notJson).error.code }).toEqual({ route, status: 400, code: 'invalid_json' });
      const unexpected = await post(target, route, { unexpected: true });
      expect({ route, status: unexpected.status, code: json(unexpected).error.code }).toEqual({ route, status: 400, code: 'invalid_body' });
    }
    expect(existsSync(target.stateRoot)).toBe(false);
    expect(target.spawns).toHaveLength(0);
  });
});

describe('changing the workspace', () => {
  it('is compare-and-swap: a stale revision is 409 with the fresh one, an invalid change is 400, and neither writes', async () => {
    const repo = await gitRepo({ 'README.md': 'checkout\n' });
    const notGit = tempDir('workforce-serve-ws-notgit-');
    const target = await office();

    const added = await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', repoPath: repo, name: 'checkout' }] });
    expect(added.status).toBe(200);
    expect(json(added)).toMatchObject({ ok: true, previousRevision: 0, revision: 1, written: true, created: { projects: ['checkout'], departments: [], agents: [] } });

    const file = workspaceFilePath(target.stateRoot);
    const sha = () => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = sha();

    const stale = await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'department.add', name: 'Engineering' }] });
    expect(stale.status).toBe(409);
    expect(json(stale)).toMatchObject({ ok: false, revision: 1, error: { code: 'workspace_revision_conflict' } });

    const refusals: Array<{ body: unknown; code: string }> = [
      { body: {}, code: 'invalid_body' },
      { body: { expectRevision: 1 }, code: 'invalid_body' },
      { body: { expectRevision: '1', ops: [{ op: 'department.add', name: 'Engineering' }] }, code: 'invalid_body' },
      { body: { expectRevision: 1, ops: [] }, code: 'invalid_body' },
      { body: { expectRevision: 1, ops: [{ op: 'project.delete', id: 'checkout' }] }, code: 'invalid_ops' },
      { body: { expectRevision: 1, ops: [{ op: 'department.add', name: 'Engineering', shell: true }] }, code: 'invalid_ops' },
      { body: { expectRevision: 1, ops: [{ op: 'agent.add', role: 'head', departmentId: 'nope', runtime: 'codex' }] }, code: 'unknown_department' },
      { body: { expectRevision: 1, ops: [{ op: 'project.add', repoPath: 'relative/checkout' }] }, code: 'invalid_repo_path' },
      { body: { expectRevision: 1, ops: [{ op: 'project.add', repoPath: notGit }] }, code: 'not_a_git_repository' },
      { body: { expectRevision: 1, ops: [{ op: 'project.add', repoPath: path.join(notGit, 'missing') }] }, code: 'project_folder_missing' },
      { body: { expectRevision: 1, ops: [{ op: 'project.edit', id: 'checkout', repoPath: '/elsewhere' }] }, code: 'path_immutable' },
      // All or nothing: the first op is valid, the second is not, and nothing is written.
      {
        body: {
          expectRevision: 1,
          ops: [
            { op: 'department.add', name: 'Engineering' },
            { op: 'agent.add', role: 'worker', departmentId: 'engineering', runtime: 'codex', projectIds: ['nope'] },
          ],
        },
        code: 'unknown_project',
      },
    ];
    for (const entry of refusals) {
      const response = await post(target, '/api/workspace/ops', entry.body);
      expect({ status: response.status, code: json(response).error.code }).toEqual({ status: 400, code: entry.code });
    }
    expect(sha()).toBe(before);
    expect(json(await rawRequest(target.server, { path: '/api/workspace' })).revision).toBe(1);
  });

  it('applies one operation through its own route, with the tool names and folders a page sends made into what the workspace stores', async () => {
    const repo = await gitRepo({ 'src/app.js': 'export {};\n' });
    const target = await office();

    // A folder inside the repository becomes the repository root, as the CLI does it.
    const project = await post(target, '/api/workspace/ops/project.add', { expectRevision: 0, repoPath: path.join(repo, 'src'), name: 'checkout' });
    expect(project.status).toBe(200);
    expect(json(project).workspace.projects[0].repoPath).toBe(realpathSync(repo));

    const department = await post(target, '/api/workspace/ops/department.add', { expectRevision: 1, name: 'Engineering', note: 'Platform' });
    expect(json(department)).toMatchObject({ revision: 2, created: { departments: ['engineering-platform'] } });

    const head = await post(target, '/api/workspace/ops/agent.add', { expectRevision: 2, role: 'head', departmentId: 'engineering-platform', runtime: 'codex', name: 'Atlas' });
    expect(head.status).toBe(200);
    const saved = json(head).workspace;
    expect(saved.agents[0]).toMatchObject({ id: 'atlas', role: 'head', runtime: 'codex-local', policy: 'analysis' });
    expect(saved.runtimes['codex-local']).toMatchObject({ adapter: 'codex' });

    const stale = await post(target, '/api/workspace/ops/agent.assign', { expectRevision: 2, agentId: 'atlas', projectId: 'checkout' });
    expect(stale.status).toBe(409);
    expect(json(stale).revision).toBe(3);
    const headOnProject = await post(target, '/api/workspace/ops/agent.assign', { expectRevision: 3, agentId: 'atlas', projectId: 'checkout' });
    expect(headOnProject.status).toBe(400);
  });
});

describe('the suggested starter department', () => {
  async function withProject(reports: ReadonlyArray<RuntimeReadinessReport>): Promise<Office> {
    const repo = await gitRepo({ 'README.md': 'checkout\n' });
    const target = await office({ discover: async () => reports });
    expect((await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', repoPath: repo, name: 'checkout' }] })).status).toBe(200);
    return target;
  }

  it('appears once there is a project and no department, puts the head on Codex when Codex is ready, and is saved only when applied', async () => {
    const target = await withProject([report('codex', true), report('claude-code', true)]);
    const document = json(await rawRequest(target.server, { path: '/api/workspace' }));
    expect(document.revision).toBe(1);
    expect(document.workspace.departments).toEqual([]);
    const starter = document.suggestedStarter;
    expect(starter).toMatchObject({
      suggested: true,
      saved: false,
      projectId: 'checkout',
      apply: { method: 'POST', path: '/api/workspace/ops', expectRevision: 1 },
      department: { name: 'Engineering' },
      head: { name: 'Engineering head', role: 'head', runtime: 'codex-local', adapter: 'codex', policy: 'analysis', projectIds: [] },
      workers: [{ name: 'Engineering worker', role: 'worker', runtime: 'codex-local', adapter: 'codex', projectIds: ['checkout'] }],
      runsOnItsOwn: false,
      runtimeChoice: { tool: 'codex', codexReady: true },
    });

    const applied = await post(target, '/api/workspace/ops', { expectRevision: starter.apply.expectRevision, ops: starter.ops });
    expect(applied.status).toBe(200);
    const after = json(await rawRequest(target.server, { path: '/api/workspace' }));
    expect(after.revision).toBe(2);
    expect(after.suggestedStarter).toBeNull();
    expect(after.workspace.departments).toEqual([expect.objectContaining({ id: starter.department.id, headAgentId: starter.head.id })]);
    expect(after.readiness.eligibility).toEqual([
      expect.objectContaining({ departmentId: starter.department.id, projectId: 'checkout', headAgentId: starter.head.id, workerIds: [starter.workers[0].id] }),
    ]);
  });

  it('uses Claude Code when only Claude Code is ready, and says that its tasks run on their own', async () => {
    const target = await withProject([report('codex', false), report('claude-code', true)]);
    const starter = json(await rawRequest(target.server, { path: '/api/workspace' })).suggestedStarter;
    expect(starter).toMatchObject({ head: { runtime: 'claude-local', adapter: 'claude-code' }, runsOnItsOwn: true, runtimeChoice: { tool: 'claude-code', codexReady: false, claudeReady: true } });
    expect(starter.runtimeChoice.reason).toContain('runs on its own');
  });
});

describe('POST /api/projects/inspect', () => {
  it('inspects and registers ~/ paths as the canonical repository, with duplicate detection', async () => {
    const fixture = await useFixture('ts-bug');
    vi.stubEnv('HOME', path.dirname(fixture.path));
    const shorthand = `~/${path.basename(fixture.path)}`;
    const target = await office();

    const inspected = await post(target, '/api/projects/inspect', { path: `${shorthand}/src` });
    expect(inspected.status).toBe(200);
    expect(json(inspected)).toMatchObject({ repositoryRoot: fixture.path, canAdd: true });
    const added = await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', repoPath: shorthand, id: 'app' }] });
    expect(added.status).toBe(200);
    expect(json(added).workspace.projects[0].repoPath).toBe(fixture.path);
    expect(json(await post(target, '/api/projects/inspect', { path: shorthand }))).toMatchObject({ canAdd: false, existingProjectId: 'app' });
    const relative = await post(target, '/api/projects/inspect', { path: '~another-user/project' });
    expect(relative.status).toBe(400);
    expect(target.spawns).toHaveLength(0);
  });

  it('reads a folder with Git — base, uncommitted changes, checks — and changes nothing', async () => {
    const fixture = await useFixture('ts-bug');
    writeFileSync(path.join(fixture.path, 'scratch-notes.txt'), 'not committed\n');
    const plain = tempDir('workforce-serve-inspect-plain-');
    mkdirSync(path.join(plain, 'nested'));
    const target = await office();

    const inspected = await post(target, '/api/projects/inspect', { path: fixture.path });
    expect(inspected.status).toBe(200);
    const document = json(inspected);
    expect(document).toMatchObject({ ok: true, exists: true, isGitRepo: true, repositoryRoot: realpathSync(fixture.path), canAdd: true, existingProjectId: null, overlapsStateRoot: false });
    expect(document.headRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(document.dirty).toMatchObject({ clean: false, untracked: 1 });
    expect(document.checks.count).toBeGreaterThan(0);

    const notGit = json(await post(target, '/api/projects/inspect', { path: path.join(plain, 'nested') }));
    expect(notGit).toMatchObject({ ok: true, exists: true, isGitRepo: false, canAdd: false });
    expect(notGit.reasons[0]).toContain('not inside a Git repository');
    expect(json(await post(target, '/api/projects/inspect', { path: path.join(plain, 'missing') }))).toMatchObject({ exists: false, canAdd: false });

    const relative = await post(target, '/api/projects/inspect', { path: 'relative/folder' });
    expect(relative.status).toBe(400);
    expect(json(relative).error.code).toBe('path_not_absolute');

    // Once it is a project, inspecting it again says so.
    expect((await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', repoPath: fixture.path, id: 'app' }] })).status).toBe(200);
    const again = json(await post(target, '/api/projects/inspect', { path: fixture.path }));
    expect(again).toMatchObject({ canAdd: false, existingProjectId: 'app' });
  });
});

describe('the legacy start route once a workspace exists', () => {
  it('refuses POST /api/runs and its preview with 409, before any process starts', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-serve-ws-legacy-');
    writeFakeAgentsConfig(stateRoot);
    const target = await office({ stateRoot });
    expect((await post(target, '/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', repoPath: fixture.path }] })).status).toBe(200);

    const start = await post(target, '/api/runs', { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: true });
    expect(start.status).toBe(409);
    expect(json(start).error.code).toBe('workspace_exists');
    const preview = await post(target, '/api/runs/preview', { repo: fixture.path });
    expect(preview.status).toBe(409);
    expect(json(preview).error.code).toBe('workspace_exists');
    expect(target.spawns).toHaveLength(0);
  });
});
