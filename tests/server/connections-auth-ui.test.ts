import { describe, expect, it, vi } from 'vitest';

const modulePath = '../../web/headquarters/src/headquarters/connections.js';
const executable = '/opt/homebrew/bin/codex';
const checkedAt = '2026-09-14T05:00:00.000Z';
function client(state = 'needs_auth', overrides: Record<string, unknown> = {}) {
  const connected = state === 'connected';
  return {
    id: 'codex', name: 'Codex', executable, installed: true, configured: true, canConnect: false,
    status: 'connected', toolsVerified: true, verification: { state: 'verified', toolCount: 7, checkedAt },
    authentication: { state, auth: connected ? 'logged_in' : 'logged_out', canSignIn: !connected && state !== 'pending',
      message: connected ? 'Signed in and ready.' : state === 'pending' ? 'Complete browser sign-in and consent.' : 'Sign in to run tasks.', checkedAt,
      login: state === 'pending' ? { id: 'login-1', executable, startedAt: checkedAt, expiresAt: '2026-09-14T05:10:00.000Z' } : null },
    execution: { usable: connected, reason: connected ? 'Ready to run tasks.' : 'Sign-in is required.' },
    ...overrides,
  };
}
function workspace() {
  return {
    workspace: { runtimes: { local: { adapter: 'codex', executable, model: 'saved-model' }, other: { adapter: 'codex', executable: '/another/codex' } } },
    runtimes: { reports: [
      { runtimeId: 'local', configuredExecutable: executable, executable, usable: true, installed: true, auth: 'logged_in', checkedAt: '2026-09-14T04:00:00.000Z' },
      { runtimeId: 'other', configuredExecutable: '/another/codex', executable: '/another/codex', usable: true, installed: true, auth: 'logged_in', checkedAt },
    ] },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Connections sign-in controls', () => {
  it('checks sign-in with one read-only request and rejects stale check results', async () => {
    const { ConnectionsStore, authenticationPresentation, summarizeConnections, renderConnectionsPage } = await import(modulePath);
    const response = deferred<{ client: ReturnType<typeof client> }>();
    const api = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce({ client: client('connected') });
    const store = new ConnectionsStore(api);
    store.clients = [client('failed')];
    expect(renderConnectionsPage(store)).toContain('data-connection-action="check-sign-in"');
    const first = store.perform('codex', 'check-sign-in');
    expect(api.mock.calls).toEqual([['/api/connections/codex/auth']]);
    expect(authenticationPresentation(store.clients[0], { action: store.actions.get('codex') }).label).toBe('Checking sign-in…');
    expect(summarizeConnections(store).readyCount).toBe(1);
    store.accept(client('denied'));
    response.resolve({ client: client('connected') });
    expect((await first).client.authentication.state).toBe('denied');
    expect(store.clients[0].authentication.state).toBe('denied');
    await store.perform('codex', 'check-sign-in');
    expect(store.clients[0].authentication.state).toBe('connected');
    expect(api.mock.calls).toEqual([['/api/connections/codex/auth'], ['/api/connections/codex/auth']]);
    store.clients = [client('unknown', { installed: false })];
    await expect(store.perform('codex', 'check-sign-in')).rejects.toThrow('Install');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('shows execution limits for a signed-in account without implying task readiness', async () => {
    const { ConnectionsStore, authenticationPresentation, runtimesForClient, renderConnectionsPage } = await import(modulePath);
    const unsupported = client('connected', { execution: { usable: false, reason: 'This runtime version lacks required execution controls.' } });
    expect(authenticationPresentation(unsupported)).toMatchObject({ ready: false, label: 'Runtime needs attention', description: 'This runtime version lacks required execution controls.' });
    const store = new ConnectionsStore(vi.fn());
    store.clients = [unsupported];
    const html = renderConnectionsPage(store, { workspace: workspace() });
    expect(html).toContain('This runtime version lacks required execution controls.');
    expect(html).not.toContain('Signed in and ready.');
    expect(html).toContain('fieldset disabled');
    expect(html).toContain('7 tools verified');
    const inconsistentWorkspace = workspace();
    inconsistentWorkspace.runtimes.reports[1]!.auth = 'logged_out';
    expect(runtimesForClient(unsupported, inconsistentWorkspace)[1].ready).toBe(false);
    const staleWorkspace = workspace();
    staleWorkspace.runtimes.reports[0]!.auth = 'logged_out';
    staleWorkspace.runtimes.reports[0]!.usable = false;
    expect(runtimesForClient(client('connected'), staleWorkspace)[0].ready).toBe(true);
  });

  it('requires an explicit sign-in action and uses only its bounded endpoint', async () => {
    const { ConnectionsStore } = await import(modulePath);
    const api = vi.fn().mockResolvedValueOnce({ clients: [client()] }).mockResolvedValueOnce({ client: client('pending') });
    const store = new ConnectionsStore(api);
    await store.scan();
    await store.pollAuthentication();
    expect(api.mock.calls).toEqual([['/api/connections']]);
    await store.perform('codex', 'sign-in');
    expect(api.mock.calls[1]).toEqual(['/api/connections/codex/sign-in', {}]);
    expect(store.clients[0].authentication.state).toBe('pending');
    expect(store.authenticationRevision).toBe(0);
    expect(store.snapshot().authenticationRevision).toBe(0);
    await expect(store.perform('codex', 'sign-in')).rejects.toThrow('browser');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('deduplicates pending reads and signals one terminal auth change without MCP verification', async () => {
    const { ConnectionsStore } = await import(modulePath);
    const response = deferred<{ client: ReturnType<typeof client> }>();
    const api = vi.fn().mockReturnValue(response.promise);
    const store = new ConnectionsStore(api);
    store.clients = [client('pending'), client('connected', { id: 'claude', name: 'Claude Code' })];
    const first = store.pollAuthentication(), second = store.pollAuthentication();
    expect(api.mock.calls).toEqual([['/api/connections/codex/auth']]);
    response.resolve({ client: client('connected') });
    await Promise.all([first, second]);
    expect(store.clients[0].authentication.state).toBe('connected');
    expect(store.authenticationRevision).toBe(1);
    await store.pollAuthentication();
    store.accept(client('connected'));
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.authenticationRevision).toBe(1);
  });

  it('rejects a late successful auth read after cancellation and allows a later retry', async () => {
    const { ConnectionsStore } = await import(modulePath);
    const response = deferred<{ client: ReturnType<typeof client> }>();
    const api = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce({ client: client('cancelled') }).mockResolvedValueOnce({ client: client('pending') });
    const store = new ConnectionsStore(api);
    store.clients = [client('pending')];
    const poll = store.pollAuthentication();
    await store.perform('codex', 'cancel-sign-in');
    response.resolve({ client: client('connected') });
    await poll;
    expect(store.clients[0].authentication.state).toBe('cancelled');
    expect(store.authenticationRevision).toBe(1);
    await store.perform('codex', 'sign-in');
    expect(api.mock.calls).toEqual([
      ['/api/connections/codex/auth'], ['/api/connections/codex/cancel-sign-in', {}], ['/api/connections/codex/sign-in', {}],
    ]);
  });

  it('keeps sign-in and polling errors separate from a verified MCP connection', async () => {
    const { ConnectionsStore, summarizeConnections, renderConnectionsPage } = await import(modulePath);
    const error = Object.assign(new Error('Provider denied this sign-in.'), { data: { client: client('denied') } });
    const api = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('Local service unavailable.'));
    const store = new ConnectionsStore(api);
    store.clients = [client()];
    await expect(store.perform('codex', 'sign-in')).rejects.toThrow('denied');
    expect(store.errors.size).toBe(0);
    expect(summarizeConnections(store).readyCount).toBe(1);
    expect(renderConnectionsPage(store)).toContain('Provider denied this sign-in.');
    expect(renderConnectionsPage(store)).toContain('Try sign-in again');
    store.accept(client('pending'));
    await store.pollAuthentication();
    expect(store.clients[0].authentication.state).toBe('pending');
    expect(store.authenticationErrors.get('codex')).toBe('Local service unavailable.');
    expect(summarizeConnections(store).readyCount).toBe(1);
  });

  it('overrides stale false-green readiness only for the exact installation', async () => {
    const { runtimesForClient } = await import(modulePath);
    for (const state of ['needs_auth', 'pending', 'failed', 'denied', 'cancelled', 'unknown']) {
      const bindings = runtimesForClient(client(state), workspace());
      expect(bindings[0].ready).toBe(false);
      expect(bindings[1].ready).toBe(true);
    }
    expect(runtimesForClient(client('connected'), workspace())[0].ready).toBe(true);
    const freshWorkspace = workspace();
    freshWorkspace.runtimes.reports[0]!.checkedAt = '2026-09-14T06:00:00.000Z';
    expect(runtimesForClient(client('needs_auth'), freshWorkspace)[0].ready).toBe(true);
    expect(runtimesForClient(client('pending'), freshWorkspace)[0].ready).toBe(false);
    expect(runtimesForClient(client('needs_auth', { executable: '/different/codex' }), workspace())[0].ready).toBe(true);
  });

  it('renders sign-in, browser consent, cancellation and disabled execution settings while MCP stays available', async () => {
    const { ConnectionsStore, renderConnectionsPage } = await import(modulePath);
    const store = new ConnectionsStore(vi.fn());
    store.clients = [client()];
    const render = () => renderConnectionsPage(store, { workspace: workspace(), renderRuntime: (id: string) => `<select data-runtime="${id}"><option>Saved model</option></select>` });
    let html = render();
    expect(html).toContain('data-connection-action="sign-in"');
    expect(html).toContain('Sign in to Codex');
    expect(html).toContain('fieldset disabled aria-disabled="true"');
    expect(html).toContain('Sign in to run tasks.');
    expect(html).toContain('7 tools verified');
    expect(html).toContain('data-connection-action="verify"');
    store.clients = [client('pending')];
    html = render();
    expect(html).toContain('Waiting for sign-in');
    expect(html).toContain('Complete browser sign-in and consent.');
    expect(html).toContain('data-connection-action="cancel-sign-in"');
    expect(html).toContain('7 tools verified');
    store.clients = [client('connected')];
    expect(render()).not.toContain('fieldset disabled');
    expect(render()).not.toContain('data-connection-action="sign-in"');
  });

  it('does not let a sign-in action or its raw message change the MCP summary or inject markup', async () => {
    const { ConnectionsStore, summarizeConnections, renderConnectionsPage } = await import(modulePath);
    const store = new ConnectionsStore(vi.fn());
    store.clients = [client('pending')];
    store.actions.set('codex', 'sign-in');
    store.authenticationErrors.set('codex', '<img src=x onerror=alert(1)>');
    expect(summarizeConnections(store).readyCount).toBe(1);
    const html = renderConnectionsPage(store);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('Connection ready');
  });
});
