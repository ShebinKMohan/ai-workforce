import { escape as esc, icon } from './ui.js';

/** A configured client is ready only after the server confirms its tool handshake. */
export function connectionPresentation(client, { action = null, error = '' } = {}) {
  if (!['connect', 'verify'].includes(action)) action = null;
  if (action) return { label: action === 'connect' ? 'Connecting…' : 'Checking connection…', tone: 'working', ready: false, description: action === 'connect' ? 'Adding the connection and checking that it works.' : 'Confirming that your agent can reach AI Workforce.' };
  if (error) return { label: 'Connection needs attention', tone: 'error', ready: false, description: error };
  if (!client.installed) return { label: 'Not found on this computer', tone: 'muted', ready: false, description: `Install ${client.name}, then scan again to connect it.` };
  if (client.status === 'conflict') return { label: 'Setup needs attention', tone: 'warning', ready: false, description: client.message || 'An existing connection needs to be reviewed before setup can continue.' };
  if (client.status === 'error' || client.error) return { label: 'Connection needs attention', tone: 'error', ready: false, description: client.error?.message || client.message || 'The connection could not be checked. Try again.' };
  if (client.status === 'needs_update') return { label: 'Connection update available', tone: 'warning', ready: false, description: 'Update this connection to use your current AI Workforce workspace.' };
  if (client.configured && client.toolsVerified === true && client.verification?.state === 'verified') return { label: 'Connection ready', tone: 'ready', ready: true, description: `${client.name} can send your plans and issues to this workforce.` };
  if (client.configured) return { label: 'Connection saved', tone: 'warning', ready: false, description: client.verification?.error || 'Check the connection to confirm that it can reach your workforce.' };
  return { label: 'Ready to connect', tone: 'available', ready: false, description: `Connect ${client.name} to send plans straight to your project board.` };
}

/** Shared with the shell: ready means a saved entry plus a successful bridge
 * round trip. It never implies that an existing external chat loaded MCP. */
export function summarizeConnections(snapshot, { error = '', loading = false } = {}) {
  const clients = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const ready = clients.filter(client => connectionPresentation(client, {
    action: snapshot?.actions?.get?.(client.id), error: snapshot?.errors?.get?.(client.id),
  }).ready);
  const installedCount = clients.filter(client => client.installed).length;
  const configuredCount = clients.filter(client => client.configured).length;
  const failure = error || snapshot?.scanError || '';
  const attentionClients = clients.filter(client => snapshot?.errors?.get?.(client.id) || ['error', 'conflict', 'needs_update'].includes(client.status));
  const attention = attentionClients.length > 0;
  const attentionReason = attention ? `${ready.length ? `${ready.length} ${ready.length===1?'agent is':'agents are'} ready. ` : ''}${attentionClients.map(client => `${client.name}: ${snapshot?.errors?.get?.(client.id) || client.error?.message || client.message || 'Connection needs attention.'}`).join(' ')}` : '';
  const working = Boolean([...(snapshot?.actions?.values?.() || [])].some(action => ['connect', 'verify'].includes(action)) || snapshot?.scanning);
  const state = failure ? 'unavailable' : ready.length ? attention ? 'attention' : 'ready'
    : attention ? 'attention' : loading || working || !snapshot?.clients ? 'checking' : 'setup_required';
  const label = state === 'unavailable' ? 'MCP · unavailable' : state === 'checking' ? 'MCP · checking'
    : state === 'attention' ? 'MCP · needs attention' : ready.length ? `MCP · ${ready.length} ready` : 'Set up MCP';
  const description = failure || attentionReason || (ready.length
    ? `${ready.map(client => client.name).join(' and ')} ${ready.length === 1 ? 'has' : 'have'} saved setup and a verified tool connection.`
    : state === 'checking' ? 'Checking saved coding-agent connections.'
    : installedCount ? 'Connect your installed coding agents in one step.' : 'Find a coding agent to connect to your workforce.');
  return { state, label, description, readyCount: failure ? 0 : ready.length, installedCount, configuredCount,
    toolCount: failure ? 0 : Math.max(0, ...ready.map(client => client.verification?.toolCount || 0)),
    checkedAt: snapshot?.checkedAt || null };
}

/** A newer page action outranks an older shell read, including a late failure. */
export class ConnectionSummaryStore {
  constructor(api, onChange = () => {}) { this.api=api; this.onChange=onChange; this.snapshot=null; this.sequence=0; this.pending=null; }
  accept(snapshot) { this.sequence++; this.snapshot=snapshot; this.onChange(summarizeConnections(snapshot)); }
  async refresh() {
    if(this.pending)return this.pending;
    const sequence=++this.sequence;
    const work=(async()=>{
      try { const snapshot=await this.api('/api/connections'); if(sequence===this.sequence){this.snapshot=snapshot;this.onChange(summarizeConnections(snapshot));} }
      catch(error) { if(sequence===this.sequence)this.onChange(summarizeConnections(this.snapshot,{error:error.message})); }
      finally { this.pending=null; }
    })();
    this.pending=work;return work;
  }
}

/** The server owns discovery, configuration and verification. Reads never configure an agent. */
export class ConnectionsStore {
  constructor(api, onChange = () => {}) {
    this.api = api; this.onChange = onChange; this.clients = null; this.serverUrl = ''; this.checkedAt = null;
    this.referenceConfiguration = null; this.bridge = null; this.scanning = false; this.scanError = ''; this.actions = new Map(); this.errors = new Map();
    this.connectingAll = false; this.connectAllPromise = null;
    this.sequence = 0; this.scanPromise = null; this.pending = new Map();
    this.authenticationRevision = 0; this.authenticationErrors = new Map(); this.authenticationPending = new Map(); this.authenticationSequences = new Map();
  }
  changed() { this.onChange(); }
  snapshot() { return { clients:this.clients,serverUrl:this.serverUrl,checkedAt:this.checkedAt,bridge:this.bridge,scanError:this.scanError,scanning:this.scanning,actions:new Map(this.actions),errors:new Map(this.errors),authenticationRevision:this.authenticationRevision }; }
  async scan(refresh = false) {
    if (this.scanPromise) return this.scanPromise;
    const sequence = ++this.sequence;
    this.scanning = true; this.scanError = ''; this.changed();
    const work = (async () => {
      try {
        const result = await this.api(`/api/connections${refresh ? '?refresh=1' : ''}`);
        if (sequence !== this.sequence) return false;
        for (const client of result.clients || []) {
          this.recordAuthentication(client);
          this.authenticationSequences.set(client.id, (this.authenticationSequences.get(client.id) || 0) + 1);
        }
        this.clients = result.clients || []; this.serverUrl = result.serverUrl || ''; this.checkedAt = result.checkedAt || null;
        this.referenceConfiguration = result.referenceConfiguration || null; this.bridge = result.bridge || null;
        this.errors.clear(); return true;
      } catch (error) { if (sequence === this.sequence) this.scanError = error.message; return false; }
      finally { this.scanning = false; this.scanPromise = null; this.changed(); }
    })();
    this.scanPromise = work;
    return work;
  }
  accept(client) {
    if (!client) return;
    this.sequence++;
    this.recordAuthentication(client);
    this.authenticationSequences.set(client.id, (this.authenticationSequences.get(client.id) || 0) + 1);
    this.clients = (this.clients || []).map(existing => existing.id === client.id ? client : existing);
    this.checkedAt = client.verification?.checkedAt || this.checkedAt;
  }
  recordAuthentication(client) {
    const previous = this.clients?.find(existing => existing.id === client.id);
    const auth = client.authentication, before = previous?.authentication;
    if (auth && auth.state !== 'pending' && before && (before.state !== auth.state || before.auth !== auth.auth || previous.executable !== client.executable)) this.authenticationRevision++;
  }
  async perform(id, action) {
    if (this.pending.has(id)) return this.pending.get(id);
    const client = this.clients?.find(item => item.id === id);
    if (!client || !['codex', 'claude'].includes(id) || !['connect', 'verify', 'sign-in', 'cancel-sign-in', 'check-sign-in'].includes(action)) throw new Error('Choose an available coding agent.');
    const authenticationAction = ['sign-in', 'cancel-sign-in', 'check-sign-in'].includes(action);
    if (action === 'connect' && !client.canConnect) throw new Error(client.message || 'This agent cannot be connected automatically yet.');
    if (action === 'verify' && !client.configured) throw new Error('Connect this agent before checking its connection.');
    if (action === 'sign-in' && !client.authentication?.canSignIn) throw new Error(client.authentication?.message || 'Sign-in is not available for this installation.');
    if (action === 'cancel-sign-in' && client.authentication?.state !== 'pending') throw new Error('There is no sign-in waiting for this agent.');
    if (action === 'check-sign-in' && !client.installed) throw new Error('Install this coding agent before checking sign-in.');
    this.authenticationSequences.set(id, (this.authenticationSequences.get(id) || 0) + 1);
    const authenticationSequence = this.authenticationSequences.get(id);
    const currentAuthentication = () => authenticationSequence === this.authenticationSequences.get(id)
      && this.clients?.some(item => item.id === id && item.executable === client.executable);
    const errors = authenticationAction ? this.authenticationErrors : this.errors;
    this.sequence++; this.actions.set(id, action); errors.delete(id); this.changed();
    const work = (async () => {
      try {
        const result = action === 'check-sign-in'
          ? await this.api(`/api/connections/${encodeURIComponent(id)}/auth`)
          : await this.api(`/api/connections/${encodeURIComponent(id)}/${action}`, {});
        if (action !== 'check-sign-in' || currentAuthentication()) { this.accept(result.client); return result; }
        return { ...result, client: this.clients?.find(item => item.id === id) };
      } catch (error) {
        if (action !== 'check-sign-in' || currentAuthentication()) {
          this.accept(error.data?.client);
          errors.set(id, error.message);
        }
        throw error;
      } finally { this.actions.delete(id); this.pending.delete(id); this.changed(); }
    })();
    this.pending.set(id, work);
    return work;
  }
  /** Called by the shell's shared timer. This read does not verify or change MCP. */
  async pollAuthentication() {
    const clients = (this.clients || []).filter(client => client.authentication?.state === 'pending');
    return Promise.allSettled(clients.map(client => {
      if (this.pending.has(client.id)) return this.pending.get(client.id);
      if (this.authenticationPending.has(client.id)) return this.authenticationPending.get(client.id);
      const sequence = this.authenticationSequences.get(client.id) || 0;
      const loginId = client.authentication.login?.id;
      const current = () => sequence === (this.authenticationSequences.get(client.id) || 0)
        && this.clients?.some(item => item.id === client.id && item.authentication?.state === 'pending' && item.authentication.login?.id === loginId);
      const work = (async () => {
        try {
          const result = await this.api(`/api/connections/${encodeURIComponent(client.id)}/auth`);
          if (current()) { this.accept(result.client); this.authenticationErrors.delete(client.id); this.changed(); }
          return result;
        } catch (error) {
          if (current()) { this.authenticationErrors.set(client.id, error.message); this.changed(); }
          throw error;
        } finally { this.authenticationPending.delete(client.id); }
      })();
      this.authenticationPending.set(client.id, work);
      return work;
    }));
  }
  async connectInstalled() {
    if (this.connectAllPromise) return this.connectAllPromise;
    const clients = (this.clients || []).filter(client => client.installed && (client.canConnect || client.configured)
      && !connectionPresentation(client, { error: this.errors.get(client.id) }).ready);
    this.connectingAll = true; this.changed();
    const work = (async () => {
      const results = [];
      // Each CLI owns its config write. Finish and reconcile one before the
      // next, while preserving partial success and useful per-client errors.
      for (const client of clients) {
        try { results.push({ id: client.id, ok: true, result: await this.perform(client.id, client.canConnect ? 'connect' : 'verify') }); }
        catch (error) { results.push({ id: client.id, ok: false, error: error.message }); }
      }
      return results;
    })();
    this.connectAllPromise = work;
    try { return await work; } finally { this.connectingAll = false; this.connectAllPromise = null; this.changed(); }
  }
}

const button = (action, label, symbol, attributes = '', primary = false) => `<button type="button" class="connection-button${primary ? ' connection-primary' : ''}" data-connection-action="${action}" ${attributes}>${symbol ? icon(symbol) : ''}<span>${label}</span></button>`;
const setupLink = client => {
  try { const url = new URL(client.setupUrl); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
};
const checkedDate = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not checked';

export function authenticationPresentation(client, { action = null, error = '' } = {}) {
  const auth = client.authentication;
  if (action === 'check-sign-in') return { label: 'Checking sign-in…', ready: false, pending: false, description: 'Checking the account used by this installation.' };
  const pending = action === 'sign-in' || action === 'cancel-sign-in' || auth?.state === 'pending';
  if (pending) return { label: action === 'cancel-sign-in' ? 'Cancelling sign-in…' : 'Waiting for sign-in', ready: false, pending: true,
    description: error || auth?.message || `Complete the ${client.name} sign-in and consent in your browser.` };
  if (error) return { label: 'Sign-in needs attention', ready: false, pending: false, description: error };
  const labels = { needs_auth: 'Sign-in needed', failed: 'Sign-in failed', denied: 'Sign-in denied', cancelled: 'Sign-in cancelled', unknown: 'Account status unknown' };
  const ready = auth?.state === 'connected' && auth.auth === 'logged_in' && client.execution?.usable === true;
  return { label: ready ? 'Ready to run tasks' : labels[auth?.state] || 'Runtime needs attention', ready, pending: false,
    description: (!ready && auth?.state === 'connected' ? client.execution?.reason : auth?.message) || client.execution?.reason || 'Execution readiness comes from the local installation.' };
}

/** Execution authentication and MCP verification are separate capabilities. */
export function runtimesForClient(client, payload) {
  const adapter = client.id === 'claude' ? 'claude-code' : client.id;
  return Object.entries(payload?.workspace?.runtimes || {}).filter(([, runtime]) => runtime.adapter === adapter).map(([id, runtime]) => {
  const report = payload?.runtimes?.reports?.find(item => item.runtimeId === id && (!item.configuredExecutable || item.configuredExecutable === runtime.executable));
  const executable = report?.executable || runtime.executable;
  const auth = client.authentication;
  const matchingAuthentication = auth && client.executable && executable === client.executable
    && (!auth.login?.executable || auth.login.executable === executable)
    && (auth.state === 'pending' || !report?.checkedAt || (Date.parse(auth.checkedAt) || 0) >= (Date.parse(report.checkedAt) || 0));
  if (matchingAuthentication) {
    const state = authenticationPresentation(client);
    return { id, runtime, report, ready: state.ready, label: state.label, reason: state.description };
  }
  const usable = report?.usable === true && report.auth !== 'logged_out';
  return { id, runtime, report, ready: usable, reason: report?.diagnostics?.join(' ') || (!report ? 'Checking the local runtime.' : report.auth === 'logged_out' ? `Sign in to ${client.name} to run tasks.` : 'This installation is not ready to run tasks.'), label: !report ? 'Checking runtime' : report.auth === 'logged_out' ? 'Sign-in needed' : usable ? 'Ready to run tasks' : report.installed ? 'Runtime needs attention' : 'Runtime unavailable' };
  });
}
export function runtimeForClient(client, payload) { return runtimesForClient(client, payload)[0] || null; }
function clientCard(client, store, options) {
  const action = store.actions.get(client.id), error = store.errors.get(client.id);
  const state = connectionPresentation(client, { action, error });
  const mcpAction = ['connect', 'verify'].includes(action) ? action : null;
  const authAction = ['sign-in', 'cancel-sign-in', 'check-sign-in'].includes(action) ? action : null;
  const authentication = client.authentication ? authenticationPresentation(client, { action: authAction, error: store.authenticationErrors?.get(client.id) }) : null;
  const bindings = runtimesForClient(client, options.workspace);
  const runtime = bindings[0] || null;
  const usableCount = bindings.filter(binding => binding.ready).length;
  const executionLabel = authAction === 'check-sign-in' ? authentication?.label : bindings.length > 1 ? `${usableCount} of ${bindings.length} runtimes ready` : runtime?.label || authentication?.label || 'Runtime not configured';
  const allReady = authAction !== 'check-sign-in' && bindings.length > 0 && usableCount === bindings.length;
  const connectLabel = client.action === 'reconnect' || client.status === 'needs_update' ? 'Repair connection' : 'Connect';
  const attrs = `data-client="${esc(client.id)}" ${action || store.connectingAll ? 'disabled' : ''}`;
  const url = setupLink(client);
  const controls = mcpAction ? button('pending', mcpAction === 'connect' ? 'Connecting…' : 'Checking…', null, `${attrs} disabled`, true)
    : !client.installed ? url ? `<a class="connection-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Get ${esc(client.name)}${icon('northeast')}</a>` : button('scan', 'Scan again', 'reset')
    : client.canConnect && (client.action || !client.configured || client.status === 'needs_update') ? button('connect', connectLabel, 'connect', `${attrs} aria-label="${connectLabel} ${esc(client.name)}"`, true)
    : client.configured ? button('verify', 'Check connection', 'reset', `${attrs} aria-label="Check ${esc(client.name)} connection"`, !state.ready) : '';
  const signInControls = authentication?.pending
    ? `${authAction === 'sign-in' ? button('pending', 'Opening sign-in…', null, 'disabled') : button('cancel-sign-in', authAction === 'cancel-sign-in' ? 'Cancelling…' : 'Cancel sign-in', null, `data-client="${esc(client.id)}" ${action ? 'disabled' : ''}`)}`
    : client.authentication?.canSignIn ? button('sign-in', ['failed', 'denied', 'cancelled'].includes(client.authentication.state) ? 'Try sign-in again' : `Sign in to ${esc(client.name)}`, 'northeast', `${attrs} aria-label="Sign in to ${esc(client.name)}"`, true) : '';
  const authenticationControls = `${signInControls}${client.installed && !authentication?.pending ? button('check-sign-in', authAction === 'check-sign-in' ? 'Checking sign-in…' : 'Check sign-in', 'reset', `${attrs} aria-label="Check ${esc(client.name)} sign-in"`) : ''}`;
  const executionDescription = authentication?.description || (bindings.length > 1 ? 'Each installation keeps its own models and account status.' : runtime?.ready ? 'Available to your agents across projects.' : runtime?.reason || 'Execution readiness comes from the local installation.');
  return `<article class="connection-agent-card connection-tone-${state.tone}" data-connection-client="${esc(client.id)}" aria-labelledby="connection-name-${esc(client.id)}" aria-busy="${Boolean(action)}">
    <div class="connection-agent-identity"><span class="connection-agent-symbol">${icon(client.id === 'codex' ? 'code' : 'layers')}</span><div><h2 id="connection-name-${esc(client.id)}">${esc(client.name)}</h2><span class="connection-agent-location">${client.installed ? `Installed${client.version ? ` · v${esc(client.version)}` : ''}` : 'Not installed'}</span></div></div>
    <div class="connection-capabilities">
      <div><span class="connection-capability-label">Runs your team’s tasks</span><strong class="${allReady ? 'connection-positive' : 'connection-caution'}" role="status"><i class="connection-state-dot ${authentication?.pending ? 'is-working' : ''}" aria-hidden="true"></i>${esc(executionLabel)}</strong><span>${esc(executionDescription)}</span>${authenticationControls ? `<div class="connection-card-actions">${authenticationControls}</div>` : ''}</div>
      <div><span class="connection-capability-label">Receives plans through MCP</span><strong class="connection-card-state" role="status"><i class="connection-state-dot ${mcpAction ? 'is-working' : ''}" aria-hidden="true"></i>${esc(state.label)}</strong><span>${esc(state.ready ? `${client.verification?.toolCount || 0} tools verified · setup saved` : state.description)}</span></div>
    </div>
    <div class="connection-card-actions">${controls}<span class="connection-check-time">${client.verification?.checkedAt ? `Checked ${esc(checkedDate(client.verification.checkedAt))}` : ''}</span></div>
    <details class="connection-tool-details" data-connection-details="${esc(client.id)}"><summary>Models & installation ${icon('down')}</summary><div>
      ${bindings.length ? bindings.map(binding => `<section class="connection-runtime-binding">${bindings.length > 1 ? `<header><strong>${esc(binding.id)}</strong><span class="${binding.ready ? 'connection-positive' : 'connection-caution'}">${esc(binding.label)}</span></header>` : ''}${!binding.ready ? `<p id="execution-unavailable-${esc(binding.id)}" class="connection-card-help">${esc(binding.reason)}</p>` : ''}<fieldset ${binding.ready ? '' : `disabled aria-disabled="true" aria-describedby="execution-unavailable-${esc(binding.id)}"`} style="border:0;padding:0;margin:0;min-width:0;${binding.ready ? '' : 'opacity:.55'}">${options.renderRuntime?.(binding.id, binding.runtime) || `<p>${esc(binding.runtime.model || 'Runtime default')}</p><code>${esc(binding.runtime.executable)}</code>`}</fieldset></section>`).join('') : '<p>No execution runtime is registered for this tool.</p>'}
      ${client.configured && client.clientReloadRequired ? `<p class="connection-reopen-note">${icon('reset')}<span>Reopen ${esc(client.name)} to load the connection in an existing chat.</span></p>` : ''}
      ${client.status === 'conflict' ? '<p class="connection-card-help">Your existing entry is preserved. See Advanced for its setup details.</p>' : ''}
    </div></details>
  </article>`;
}

/** Rendered independently so readiness and failures remain testable without a browser runtime. */
export function renderConnectionsPage(store, { advancedConfig = '', workspace = null, renderRuntime = null, renderInstallations = null } = {}) {
  const clients = store.clients || [], summary = summarizeConnections(store, { loading: store.scanning });
  const ready = summary.readyCount > 0;
  const actionable = clients.filter(client => client.installed && (client.canConnect || client.configured)
    && !connectionPresentation(client, { error: store.errors.get(client.id) }).ready);
  const bridgeName = store.bridge?.name || 'ai-workforce';
  return `<section class="connections-page" aria-label="Agent connections">
    <header class="connection-page-header"><div><h1>Connections</h1><p>Your coding tools, task runtimes, and MCP setup in one place.</p></div>${button('scan', store.scanning ? 'Scanning…' : 'Scan this computer', 'reset', store.scanning || store.connectingAll ? 'disabled' : '')}</header>
    <section class="connection-bridge connection-bridge-compact" aria-label="MCP connection status"><span class="connection-bridge-symbol">${icon('connect')}</span><div><strong>${ready ? `${summary.readyCount} MCP ${summary.readyCount === 1 ? 'connection' : 'connections'} ready` : summary.state === 'checking' ? 'Checking your connections' : 'Connect your coding tools'}</strong><p>${actionable.length ? 'One click saves the connection and checks its tools. Send a plan from your coding agent to get started.' : 'Send a plan from your coding agent. Control Center assigns the team.'}</p></div>${actionable.length || store.connectingAll ? button('connect-all', store.connectingAll ? 'Connecting agents…' : 'Connect installed agents', 'connect', store.connectingAll || store.scanning ? 'disabled' : '', true) : button('issues', 'Open Issues', 'arrow')}</section>
    <div class="connection-scan-status" role="status">${icon(store.scanning ? 'search' : 'monitor')}<span>${store.scanning ? 'Looking for installed coding agents…' : store.scanError ? 'Scan could not finish' : store.clients ? `${summary.installedCount} installed ${summary.installedCount === 1 ? 'agent' : 'agents'} found` : 'Finding your agents…'}</span>${store.checkedAt && !store.scanning ? `<time datetime="${esc(store.checkedAt)}">Checked ${esc(checkedDate(store.checkedAt))}</time>` : ''}</div>
    ${store.scanError ? `<div class="connection-error" role="alert"><div><strong>Couldn’t check your agents</strong><p>${esc(store.scanError)}${store.clients ? ' The last detected setup is shown below.' : ''}</p></div>${button('scan', 'Try again', 'reset')}</div>` : ''}
    <div class="connection-agent-grid">${store.clients ? clients.length ? clients.map(client => clientCard(client, store, { workspace, renderRuntime })).join('') : `<div class="connection-empty">${icon('search')}<h2>No agent information returned</h2><p>Scan again to check the agents available on this computer.</p>${button('scan', 'Scan again', 'reset')}</div>` : `<div class="connection-loading" role="status">${icon('search')}<div><strong>${store.scanError ? 'Waiting for a connection' : 'Finding your coding agents'}</strong><p>${store.scanError ? 'Try again when your local workspace is available.' : 'Your installed Codex and Claude Code agents will appear here.'}</p></div></div>`}</div>
    <details class="connection-advanced" data-connection-advanced><summary>Advanced <span>Connection details and troubleshooting</span></summary><div class="connection-advanced-body"><p>Verification starts the local bridge, initializes MCP, lists its tools, and reads your registered projects. It starts no model task. The open-session status of external coding agents is not observed.</p><dl><div><dt>Bridge identity</dt><dd>${esc(bridgeName)}</dd></div><div><dt>Connection type</dt><dd>Local stdio MCP · available across your agent’s projects</dd></div>${store.serverUrl ? `<div><dt>Workforce service</dt><dd>${esc(store.serverUrl)} · local coordinator address, not an HTTP MCP endpoint</dd></div>` : ''}</dl>${clients.map(client => `<section><h3>${esc(client.name)}</h3><dl><div><dt>Installation</dt><dd>${esc(client.executable || 'Not detected')}</dd></div><div><dt>Version</dt><dd>${esc(client.version || 'Unavailable')}</dd></div><div><dt>Configuration</dt><dd>${client.configured ? 'Saved for this user' : 'Not configured'}</dd></div><div><dt>Tool verification</dt><dd>${esc(client.verification?.state || 'not_checked')}${client.verification?.toolCount ? ` · ${esc(client.verification.toolCount)} tools` : ''} · ${esc(checkedDate(client.verification?.checkedAt))}</dd></div><div><dt>Open agent session</dt><dd>Not observed · reopen an existing chat after connecting</dd></div>${client.verification?.error ? `<div><dt>Last check</dt><dd>${esc(client.verification.error)}</dd></div>` : ''}${client.error?.message ? `<div><dt>Setup message</dt><dd>${esc(client.error.message)}</dd></div>` : ''}</dl></section>`).join('')}${advancedConfig ? `<details class="connection-reference"><summary>Reference configuration for other MCP clients</summary><pre tabindex="0"><code>${esc(advancedConfig)}</code></pre></details>` : ''}${renderInstallations ? renderInstallations() : ''}</div></details>
  </section>`;
}

export function createConnections({ api, notify = () => {}, onNavigate = () => {}, getWorkspace = () => null, renderRuntime = null, renderInstallations = null, refreshRuntime = async () => {} }) {
  let host = null, advancedConfig = '';
  const store = new ConnectionsStore(api, () => { render(); announceChange(); });
  function announceChange() {
    document.dispatchEvent(new CustomEvent('workforce:connections-changed', { detail: store.snapshot() }));
  }
  function render() {
    if (!host) return;
    const focused = document.activeElement;
    const focusAction = host.contains(focused) ? focused.dataset?.connectionAction : null;
    const focusClient = host.contains(focused) ? focused.dataset?.client : null;
    const advancedOpen = Boolean(host.querySelector('[data-connection-advanced]')?.open);
    const opened = [...host.querySelectorAll('[data-connection-details][open], [data-runtime-catalog][open]')].map(element => [element.hasAttribute('data-connection-details') ? 'data-connection-details' : 'data-runtime-catalog', element.getAttribute('data-connection-details') || element.getAttribute('data-runtime-catalog')]);
    advancedConfig = store.referenceConfiguration ? JSON.stringify(store.referenceConfiguration, null, 2) : '';
    host.innerHTML = renderConnectionsPage(store, { advancedConfig, workspace: getWorkspace(), renderRuntime, renderInstallations });
    if (advancedOpen) host.querySelector('[data-connection-advanced]').open = true;
    for (const [attribute, value] of opened) [...host.querySelectorAll(`[${attribute}]`)].find(element => element.getAttribute(attribute) === value)?.setAttribute('open', '');
    if (focusAction) [...host.querySelectorAll('[data-connection-action]')].find(button => button.dataset.connectionAction === focusAction && (!focusClient || button.dataset.client === focusClient) && !button.disabled)?.focus();
  }
  async function click(event) {
    const target = event.target.closest('[data-connection-action]'); if (!target || target.disabled) return;
    const action = target.dataset.connectionAction;
    if (action === 'scan') { await Promise.allSettled([store.scan(true), refreshRuntime()]); render(); announceChange(); return; }
    if (action === 'issues') { onNavigate('issues'); return; }
    if (action === 'connect-all') {
      const results = await store.connectInstalled();
      const passed = results.filter(result => result.ok).length;
      notify(results.every(result => result.ok) ? `${passed} ${passed === 1 ? 'agent is' : 'agents are'} ready to use MCP.` : 'Setup finished. Check the highlighted agent for the remaining step.');
      announceChange(); return;
    }
    if (['connect', 'verify', 'sign-in', 'cancel-sign-in', 'check-sign-in'].includes(action)) {
      try {
        const result = await store.perform(target.dataset.client, action);
        if (['sign-in', 'cancel-sign-in', 'check-sign-in'].includes(action)) {
          notify(result.client ? authenticationPresentation(result.client).description : action === 'sign-in' ? 'Complete sign-in in your browser.' : action === 'cancel-sign-in' ? 'Sign-in cancelled.' : 'Sign-in checked.');
        } else {
          const state = result.client && connectionPresentation(result.client);
          notify(state?.ready ? `${result.client.name} connection is ready.` : result.client?.message || 'The connection needs another check.');
        }
      } catch (error) { notify(error.message); }
      announceChange();
    }
  }
  function unmount() { if (host) host.removeEventListener('click', click); host = null; }
  return {
    mount(element) {
      unmount(); host = element;
      render(); host.addEventListener('click', click); void store.scan().then(announceChange);
    }, unmount, refresh: render, pollAuthentication: () => store.pollAuthentication(),
    get authenticationRevision() { return store.authenticationRevision; },
  };
}
