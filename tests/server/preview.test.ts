/**
 * `POST /api/runs/preview` (FR084, FR083's promise in the office): before a
 * model turn is spent, the page shows the repository, the agent, the checks
 * the verifier will run and the write-boundary question — read by the
 * functions the run itself calls, behind the start route's own proofs, and
 * starting nothing.
 */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../src/server/index.js';
import type { Spawner } from '../../src/server/launch.js';
import { git } from '../../src/workspaces/git.js';
import { cleanupAll, fingerprintCheckout, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig } from '../workspaces/support.js';
import { originFor, rawRequest, tokenFrom, type RawResponse } from './support.js';

afterEach(() => cleanupAll());

const spawned: string[] = [];
const neverSpawn: Spawner = (command) => {
  spawned.push(command);
  throw new Error('a preview must never start a process');
};

async function office(stateRoot: string, extra: Partial<OfficeServerOptions> = {}): Promise<{ server: OfficeServer; token: string }> {
  const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [], spawner: neverSpawn, ...extra });
  registerCleanup(() => void server.close());
  return { server, token: await tokenFrom(server) };
}

function preview(server: OfficeServer, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return rawRequest(server, {
    method: 'POST',
    path: '/api/runs/preview',
    headers: { origin: originFor(server), 'content-type': 'application/json', ...(token === null ? {} : { 'x-workforce-token': token }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const json = (response: RawResponse): Record<string, any> => JSON.parse(response.body) as Record<string, any>;

describe('POST /api/runs/preview', () => {
  it('needs every proof a start request needs, and "preview" is never read as a run id', async () => {
    const stateRoot = tempDir('workforce-preview-gate-');
    writeFakeAgentsConfig(stateRoot);
    const { server, token } = await office(stateRoot);
    const fixture = await useFixture('ts-bug');

    expect(json(await preview(server, null, { repo: fixture.path })).error.code).toBe('token_required');
    expect((await preview(server, 'f'.repeat(token.length), { repo: fixture.path })).status).toBe(403);
    expect(json(await preview(server, token, { repo: fixture.path }, { origin: 'http://evil.example' })).error.code).toBe('origin_rejected');

    const get = await rawRequest(server, { path: '/api/runs/preview' });
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
  });

  it('shows the repository, the agent, the verifier’s checks and the consent question — and starts nothing, touches nothing', async () => {
    const stateRoot = tempDir('workforce-preview-ok-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const before = await fingerprintCheckout(fixture.path);
    const { server, token } = await office(stateRoot);

    const response = await preview(server, token, { repo: fixture.path });
    expect(response.status).toBe(200);
    const document = json(response);
    expect(document.repository).toMatchObject({ root: realpathSync(fixture.path), workingTree: 'clean' });
    expect(document.repository.headRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(document.configuration.path).toBe(path.join(stateRoot, 'agents.json'));
    expect(document.agent).toMatchObject({ id: 'engineer', adapter: 'fake', policy: 'local-development', isDefaultWorker: true });
    expect(document.runtime).toBeNull();
    // The same resolver the run uses, pinned to the base revision: the fixture's .workforce/checks.json.
    expect(document.checks).toMatchObject({ source: 'repository_config', error: null });
    expect(document.checks.criteria).toEqual([{ criterionId: 'node-tests-pass', description: expect.any(String), command: 'node', args: ['--test', 'test/'], required: true }]);
    // The fake adapter reports no write containment, so starting it needs explicit consent.
    expect(document.writeBoundary).toMatchObject({ writes: true, unconfinedWrites: true, requiresAllowUnconfinedWrites: true });
    expect(document.writeBoundary.explanation).toContain('unsupported');
    expect(document.blockers).toEqual([]);

    expect(spawned).toEqual([]);
    expect(existsSync(path.join(stateRoot, 'serve'))).toBe(false);
    expect(existsSync(path.join(stateRoot, 'state.sqlite'))).toBe(false);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  });

  it('refuses what a start refuses with the same code, and names a repository with no acceptance check as a blocker', async () => {
    const stateRoot = tempDir('workforce-preview-refuse-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const { server, token } = await office(stateRoot);

    const cases: Array<{ body: unknown; code: string }> = [
      { body: 'not json', code: 'invalid_json' },
      { body: { repo: fixture.path, task: 'previews take no task' }, code: 'invalid_body' },
      { body: { repo: 'relative/path' }, code: 'repo_not_absolute' },
      { body: { repo: path.join(stateRoot, 'missing') }, code: 'invalid_repo' },
      { body: { repo: stateRoot }, code: 'not_a_git_repository' },
      { body: { repo: fixture.path, agent: 'nobody' }, code: 'unknown_agent' },
    ];
    for (const entry of cases) {
      const response = await preview(server, token, entry.body);
      expect({ status: response.status, code: json(response).error.code }).toEqual({ status: 400, code: entry.code });
    }

    const bare = tempDir('workforce-preview-bare-');
    await git(['init', '--quiet'], { cwd: bare });
    writeFileSync(path.join(bare, 'README.md'), 'no checks here\n');
    await git(['add', 'README.md'], { cwd: bare });
    await git(['-c', 'user.name=Workforce Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'init'], { cwd: bare });
    const document = json(await preview(server, token, { repo: bare }));
    expect(document.checks.criteria).toEqual([]);
    expect(document.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['no_acceptance_checks']);
    expect(spawned).toEqual([]);
  });
});

describe('GET /api/office runtime reports', () => {
  it('carry the documented sign-in command, so a signed-out runtime can say how to sign in', async () => {
    const stateRoot = tempDir('workforce-office-login-');
    const report = {
      adapter: 'codex',
      displayName: 'Codex CLI',
      executable: '/opt/bin/codex',
      realPath: '/opt/bin/codex',
      version: '0.147.0',
      installed: true,
      adapterSupported: true,
      controllable: true,
      auth: 'logged_out',
      readiness: 'controllable',
      capabilities: {},
      checkedAt: '2026-09-11T10:00:00.000Z',
      minimumSupportedVersion: '0.140.0',
      installations: [],
      searchedLocations: [],
      probes: [],
      probeKind: 'passive',
      authDetail: '`codex login status` reports no active login',
      missingControls: [],
      missingWriteBoundary: [],
      writingModeAvailable: true,
      diagnostics: [],
    } as unknown as RuntimeReadinessReport;
    const { server } = await office(stateRoot, { discover: async () => [report] });
    const document = json(await rawRequest(server, { path: '/api/office' }));
    expect(document.runtimes.reports[0]).toMatchObject({ adapter: 'codex', auth: 'logged_out', loginHint: 'codex login' });
  });
});
