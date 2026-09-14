import { escape as esc, icon } from './ui.js';

/** A configured client is ready only after the server confirms its tool handshake. */
export function connectionPresentation(client, { action = null, error = '' } = {}) {
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
  const working = Boolean(snapshot?.actions?.size || snapshot?.scanning);
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
  }
  changed() { this.onChange(); }
  snapshot() { return { clients:this.clients,serverUrl:this.serverUrl,checkedAt:this.checkedAt,bridge:this.bridge,scanError:this.scanError,scanning:this.scanning,actions:new Map(this.actions),errors:new Map(this.errors) }; }
  async scan(refresh = false) {
    if (this.scanPromise) return this.scanPromise;
    const sequence = ++this.sequence;
    this.scanning = true; this.scanError = ''; this.changed();
    const work = (async () => {
      try {
        const result = await this.api(`/api/connections${refresh ? '?refresh=1' : ''}`);
        if (sequence !== this.sequence) return false;
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
    this.clients = (this.clients || []).map(existing => existing.id === client.id ? client : existing);
    this.checkedAt = client.verification?.checkedAt || this.checkedAt;
  }
  async perform(id, action) {
    if (this.pending.has(id)) return this.pending.get(id);
    const client = this.clients?.find(item => item.id === id);
    if (!client || !['codex', 'claude'].includes(id) || !['connect', 'verify'].includes(action)) throw new Error('Choose an available coding agent.');
    if (action === 'connect' && !client.canConnect) throw new Error(client.message || 'This agent cannot be connected automatically yet.');
    if (action === 'verify' && !client.configured) throw new Error('Connect this agent before checking its connection.');
    this.sequence++; this.actions.set(id, action); this.errors.delete(id); this.changed();
    const work = (async () => {
      try {
        const result = await this.api(`/api/connections/${encodeURIComponent(id)}/${action}`, {});
        this.accept(result.client);
        return result;
      } catch (error) {
        this.accept(error.data?.client);
        this.errors.set(id, error.message);
        throw error;
      } finally { this.actions.delete(id); this.pending.delete(id); this.changed(); }
    })();
    this.pending.set(id, work);
    return work;
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

function clientCard(client, store) {
  const action = store.actions.get(client.id), error = store.errors.get(client.id);
  const state = connectionPresentation(client, { action, error });
  const connectLabel = client.action === 'reconnect' || client.status === 'needs_update' ? 'Repair connection' : 'Connect';
  const attrs = `data-client="${esc(client.id)}" ${action || store.connectingAll ? 'disabled' : ''}`;
  const url = setupLink(client);
  const observedVerified = client.toolsVerified === true && client.verification?.state === 'verified';
  return `<article class="connection-agent-card connection-tone-${state.tone}" data-connection-client="${esc(client.id)}" aria-labelledby="connection-name-${esc(client.id)}" aria-busy="${Boolean(action)}">
    <div class="connection-agent-identity"><span class="connection-agent-symbol">${icon(client.id === 'codex' ? 'code' : 'layers')}</span><div><h2 id="connection-name-${esc(client.id)}">${esc(client.name)}</h2><span class="connection-agent-location">${client.installed ? `Installed${client.version ? ` · v${esc(client.version)}` : ''}` : 'Not installed'}</span></div><span class="connection-client-tag">MCP</span></div>
    <div class="connection-card-state" role="status"><span class="connection-state-dot ${action ? 'is-working' : ''}" aria-hidden="true"></span><strong>${esc(state.label)}</strong></div>
    <p class="connection-card-description">${esc(state.description)}</p>
    <div class="connection-checkpoints" aria-label="${esc(client.name)} setup checks"><span class="${client.configured ? 'is-passed' : ''}">${icon(client.configured ? 'circleCheck' : 'clock')}Setup ${client.configured ? 'saved' : 'pending'}</span><span class="${observedVerified ? 'is-passed' : ''}">${icon(observedVerified ? 'circleCheck' : 'clock')}${observedVerified ? `${esc(client.verification.toolCount)} tools verified` : 'Tool check pending'}</span></div>
    <div class="connection-card-actions">${action ? button('pending', action === 'connect' ? 'Connecting…' : 'Checking…', null, `${attrs} aria-label="${action === 'connect' ? 'Connecting' : 'Checking'} ${esc(client.name)}"`, true) : !client.installed ? url ? `<a class="connection-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Get ${esc(client.name)}${icon('northeast')}</a>` : button('scan', 'Scan again', 'reset') : client.canConnect && (client.action || !client.configured || client.status === 'needs_update') ? button('connect', connectLabel, 'connect', `${attrs} aria-label="${connectLabel} ${esc(client.name)}"`, true) : ''}${client.configured && !action ? button('verify', 'Check connection', 'reset', `${attrs} aria-label="Check ${esc(client.name)} connection"`, !state.ready && !client.canConnect) : ''}<span class="connection-check-time">${client.verification?.checkedAt ? `Checked ${esc(checkedDate(client.verification.checkedAt))}` : ''}</span></div>
    ${client.configured && client.clientReloadRequired && !action ? `<p class="connection-reopen-note">${icon('reset')}<span>Reopen ${esc(client.name)} to load the connection in an existing chat.</span></p>` : ''}
    ${client.installed && client.status === 'conflict' && !action ? '<p class="connection-card-help">Your existing entry is preserved. See Advanced for its setup details.</p>' : ''}
    ${!state.ready && observedVerified && error ? '<p class="connection-card-help">An earlier check passed; the latest check needs attention.</p>' : ''}
  </article>`;
}

/** Rendered independently so readiness and failures remain testable without a browser runtime. */
export function renderConnectionsPage(store, { advancedConfig = '' } = {}) {
  const clients = store.clients || [], summary = summarizeConnections(store, { loading: store.scanning });
  const ready = summary.readyCount > 0;
  const actionable = clients.filter(client => client.installed && (client.canConnect || client.configured)
    && !connectionPresentation(client, { error: store.errors.get(client.id) }).ready);
  const bridgeName = store.bridge?.name || 'ai-workforce';
  return `<section class="connections-page" aria-label="Agent connections">
    <header class="connection-page-header"><div><p class="eyebrow">CONNECTED WORKSPACE</p><h1>MCP connections</h1><p>Bring plans from your coding agents straight to your workforce.</p></div>${button('scan', store.scanning ? 'Scanning…' : 'Scan again', 'reset', store.scanning || store.connectingAll ? 'disabled' : '')}</header>
    <section class="connection-bridge" aria-label="MCP connection status"><div class="connection-bridge-heading"><span class="connection-bridge-symbol">${icon('connect')}</span><div><span class="connection-kicker">LOCAL MCP BRIDGE</span><h2>One connection. Your whole team.</h2></div><span class="connection-summary-state connection-tone-${ready ? 'ready' : summary.state === 'attention' || summary.state === 'unavailable' ? 'warning' : 'available'}"><span class="connection-state-dot" aria-hidden="true"></span>${esc(ready ? `${summary.readyCount} ${summary.readyCount === 1 ? 'agent' : 'agents'} ready` : summary.state === 'checking' ? 'Checking setup' : summary.state === 'unavailable' ? 'Connection unavailable' : summary.state === 'attention' ? 'Needs attention' : 'Setup required')}</span></div>
      <div class="connection-readouts"><div><span>Bridge identity</span><strong>${esc(bridgeName)}</strong></div><div><span>Transport</span><strong>Local stdio MCP</strong></div><div><span>Tools verified</span><strong>${summary.toolCount ? `${summary.toolCount} available` : 'Awaiting check'}</strong></div><div><span>Project access</span><strong>Your registered projects</strong></div></div>
      <div class="connection-bridge-footer"><p>${store.connectingAll ? 'Saving setup and testing each installed agent…' : actionable.length ? 'Connect once. We save the setup and test the connection for you.' : ready ? 'Saved setup and a successful tool check. An open agent chat loads it separately.' : 'Your installed agents appear below. Setup and connection checks happen here.'}</p>${actionable.length || store.connectingAll ? button('connect-all', store.connectingAll ? 'Connecting agents…' : 'Connect installed agents', 'connect', store.connectingAll || store.scanning ? 'disabled' : '', true) : ''}</div>
    </section>
    <div class="connection-scan-status" role="status">${icon(store.scanning ? 'search' : 'monitor')}<span>${store.scanning ? 'Looking for installed coding agents…' : store.scanError ? 'Scan could not finish' : store.clients ? `${summary.installedCount} installed ${summary.installedCount === 1 ? 'agent' : 'agents'} found` : 'Finding your agents…'}</span>${store.checkedAt && !store.scanning ? `<time datetime="${esc(store.checkedAt)}">Checked ${esc(checkedDate(store.checkedAt))}</time>` : ''}</div>
    ${store.scanError ? `<div class="connection-error" role="alert"><div><strong>Couldn’t check your agents</strong><p>${esc(store.scanError)}${store.clients ? ' The last detected setup is shown below.' : ''}</p></div>${button('scan', 'Try again', 'reset')}</div>` : ''}
    <div class="connection-agent-grid">${store.clients ? clients.length ? clients.map(client => clientCard(client, store)).join('') : `<div class="connection-empty">${icon('search')}<h2>No agent information returned</h2><p>Scan again to check the agents available on this computer.</p>${button('scan', 'Scan again', 'reset')}</div>` : `<div class="connection-loading" role="status">${icon('search')}<div><strong>${store.scanError ? 'Waiting for a connection' : 'Finding your coding agents'}</strong><p>${store.scanError ? 'Try again when your local workspace is available.' : 'Your installed Codex and Claude Code agents will appear here.'}</p></div></div>`}</div>
    <section class="connection-next-step"><div class="connection-next-heading"><span class="connection-next-icon">${icon('board')}</span><div><p class="eyebrow">${ready ? 'READY TO HAND OFF' : 'YOUR NEXT STEP'}</p><h2>Send a plan. Follow its progress.</h2></div>${button('issues', 'Open Issues', 'arrow', '', ready)}</div><p>In your coding agent, ask:</p><blockquote>“Send this plan to AI Workforce for my project and have the team start working on it.”</blockquote><ol class="connection-flow" aria-label="Plan handoff flow"><li>${icon('file')}<span>Plan received</span></li><li>${icon('org')}<span>Team assigned</span></li><li>${icon('board')}<span>Progress on Issues</span></li></ol></section>
    <details class="connection-advanced" data-connection-advanced><summary>Advanced <span>Connection details and troubleshooting</span></summary><div class="connection-advanced-body"><p>Verification starts the local bridge, initializes MCP, lists its tools, and reads your registered projects. It starts no model task. The open-session status of external coding agents is not observed.</p><dl><div><dt>Bridge identity</dt><dd>${esc(bridgeName)}</dd></div><div><dt>Connection type</dt><dd>Local stdio MCP · available across your agent’s projects</dd></div>${store.serverUrl ? `<div><dt>Workforce service</dt><dd>${esc(store.serverUrl)} · local coordinator address, not an HTTP MCP endpoint</dd></div>` : ''}</dl>${clients.map(client => `<section><h3>${esc(client.name)}</h3><dl><div><dt>Installation</dt><dd>${esc(client.executable || 'Not detected')}</dd></div><div><dt>Version</dt><dd>${esc(client.version || 'Unavailable')}</dd></div><div><dt>Configuration</dt><dd>${client.configured ? 'Saved for this user' : 'Not configured'}</dd></div><div><dt>Tool verification</dt><dd>${esc(client.verification?.state || 'not_checked')}${client.verification?.toolCount ? ` · ${esc(client.verification.toolCount)} tools` : ''} · ${esc(checkedDate(client.verification?.checkedAt))}</dd></div><div><dt>Open agent session</dt><dd>Not observed · reopen an existing chat after connecting</dd></div>${client.verification?.error ? `<div><dt>Last check</dt><dd>${esc(client.verification.error)}</dd></div>` : ''}${client.error?.message ? `<div><dt>Setup message</dt><dd>${esc(client.error.message)}</dd></div>` : ''}</dl></section>`).join('')}${advancedConfig ? `<details class="connection-reference"><summary>Reference configuration for other MCP clients</summary><pre tabindex="0"><code>${esc(advancedConfig)}</code></pre></details>` : ''}</div></details>
  </section>`;
}

export function createConnections({ api, notify = () => {}, onNavigate = () => {} }) {
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
    advancedConfig = store.referenceConfiguration ? JSON.stringify(store.referenceConfiguration, null, 2) : '';
    host.innerHTML = renderConnectionsPage(store, { advancedConfig });
    if (advancedOpen) host.querySelector('[data-connection-advanced]').open = true;
    if (focusAction) [...host.querySelectorAll('[data-connection-action]')].find(button => button.dataset.connectionAction === focusAction && (!focusClient || button.dataset.client === focusClient) && !button.disabled)?.focus();
  }
  async function click(event) {
    const target = event.target.closest('[data-connection-action]'); if (!target || target.disabled) return;
    const action = target.dataset.connectionAction;
    if (action === 'scan') { await store.scan(true); announceChange(); return; }
    if (action === 'issues') { onNavigate('issues'); return; }
    if (action === 'connect-all') {
      const results = await store.connectInstalled();
      const passed = results.filter(result => result.ok).length;
      notify(results.every(result => result.ok) ? `${passed} ${passed === 1 ? 'agent is' : 'agents are'} ready to use MCP.` : 'Setup finished. Check the highlighted agent for the remaining step.');
      announceChange(); return;
    }
    if (action === 'connect' || action === 'verify') {
      try {
        const result = await store.perform(target.dataset.client, action);
        const state = result.client && connectionPresentation(result.client);
        notify(state?.ready ? `${result.client.name} connection is ready.` : result.client?.message || 'The connection needs another check.');
      } catch (error) { notify(error.message); }
      announceChange();
    }
  }
  function unmount() { if (host) host.removeEventListener('click', click); host = null; }
  return {
    mount(element) {
      unmount(); host = element;
      render(); host.addEventListener('click', click); void store.scan().then(announceChange);
    }, unmount,
  };
}
