const STORAGE_KEY = 'agent-office-config-v1';
const MAX_CUSTOM_AGENTS = 500;
const CONFIG_FIELDS = ['name', 'role', 'departmentId', 'provider', 'customProvider', 'model', 'runtime', 'instructions', 'endpoint', 'credentialEnv', 'temperature'];
const RUNTIME_TYPES = new Set(['codex-cli', 'claude-code', 'ollama', 'api']);

export const providers = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google' },
  { id: 'ollama', name: 'Ollama / local' },
  { id: 'custom', name: 'Custom provider' },
];

const roleInstructions = {
  Lead: 'Break department objectives into clear assignments, coordinate the team, and summarize progress and blockers.',
  Researcher: 'Investigate questions, compare reliable sources, and produce concise findings with evidence and uncertainty.',
  Analyst: 'Analyze the available evidence, explain patterns and limitations, and make recommendations that follow from the data.',
  Knowledge: 'Organize shared knowledge, keep references traceable, and turn useful findings into clear reusable guidance.',
  Developer: 'Implement focused software changes, verify the affected behavior, and explain relevant tradeoffs and remaining issues.',
  QA: 'Check expected behavior and edge cases, reproduce defects, and report actionable findings with clear steps.',
  DevOps: 'Prepare reliable development environments, inspect delivery issues, and make operational changes only within the assigned scope.',
  UX: 'Understand user goals, map clear interaction flows, and evaluate usability and accessibility.',
  Visual: 'Create coherent visual assets and interface details that follow the established design direction.',
  Prototype: 'Build useful interaction prototypes and document what is demonstrated and what remains unimplemented.',
  Content: 'Write clear, accurate content for the intended audience and maintain the agreed tone and message.',
  Sales: 'Prepare relevant customer materials and follow-up drafts using supported product information.',
  Outreach: 'Research suitable audiences and prepare targeted outreach drafts for review.',
  Operations: 'Organize recurring work, maintain clear records, and surface dependencies and operational blockers.',
  Finance: 'Reconcile provided financial information, explain assumptions, and flag discrepancies for review.',
  Review: 'Review assigned work against its requirements, distinguish blocking issues from suggestions, and explain each finding.',
  Support: 'Understand customer questions, provide accurate guidance from available knowledge, and escalate unresolved issues.',
  Triage: 'Classify incoming requests, assess urgency from the provided evidence, and route them to the appropriate owner.',
};

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function failure(fields, message = 'Please check the highlighted agent settings.') {
  const error = new Error(message);
  error.fields = fields;
  return error;
}

function pickConfig(agent) {
  return Object.fromEntries(CONFIG_FIELDS.map(key => [key, agent[key]]));
}

function runtimeKey(agent) {
  return JSON.stringify([agent.provider, agent.customProvider || '', agent.model, agent.runtime, agent.endpoint || '']);
}

function keyHash(value) {
  // Two independent 32-bit accumulators; collisions are additionally checked below.
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

/** Local configuration only. This store neither discovers nor connects model runtimes. */
export function createAgentStore({ employees, departments, runtimes, control, storage = defaultStorage() }) {
  const baseRuntimes = runtimes.filter(runtime => !runtime.isConfigured).map(runtime => ({
    ...runtime,
    provider: runtime.id === 'claude' ? 'anthropic' : runtime.id === 'local' ? 'ollama' : 'openai',
    runtime: runtime.id === 'claude' ? 'claude-code' : runtime.id === 'local' ? 'ollama' : 'codex-cli',
    endpoint: '',
  }));
  const originalAgents = employees.filter(agent => !agent.isCustom);
  const providerIds = new Set(providers.map(provider => provider.id));
  const departmentIds = new Set(departments.map(department => department.id));
  let storageWarning = '';
  let overrides = new Map();
  let added = [];

  const defaultFor = agent => {
    const runtimeId = agent.runtimeId || 'codex';
    const base = baseRuntimes.find(runtime => runtime.id === runtimeId) || baseRuntimes[0];
    const department = departments.find(item => item.id === agent.departmentId);
    return {
      provider: runtimeId === 'claude' ? 'anthropic' : runtimeId === 'local' ? 'ollama' : 'openai',
      customProvider: '',
      model: base?.model || 'GPT-5.5',
      runtime: runtimeId === 'claude' ? 'claude-code' : runtimeId === 'local' ? 'ollama' : 'codex-cli',
      instructions: `You are ${agent.name}, the ${agent.role} agent in ${department?.name || 'the office'}. ${roleInstructions[agent.role] || 'Complete assigned work within your role, explain your assumptions, and report progress and blockers clearly.'} Coordinate with the office coordinator when work depends on another department.`,
      endpoint: '',
      credentialEnv: '',
      temperature: 0.3,
    };
  };
  for (const agent of originalAgents) Object.assign(agent, defaultFor(agent), { isCustom: false, isCoordinator: false });
  const coordinator = {
    ...control, name: 'Atlas', role: 'Office coordinator', departmentId: 'control',
    runtimeId: 'codex', status: 'configured', task: '', isCoordinator: true, isCustom: false,
    provider: 'openai', customProvider: '', model: 'GPT-5.5', runtime: 'codex-cli',
    instructions: 'You are Atlas, the office coordinator. Clarify the user\'s objective, delegate suitable work to department leads, track dependencies, and synthesize results. Keep the user informed of progress and blockers. Use only configured capabilities and report when a runtime is unavailable.',
    endpoint: '', credentialEnv: '', temperature: 0.3,
  };
  const baselines = new Map([...originalAgents, coordinator].map(agent => [agent.id, { ...agent }]));

  function validate(values, existing) {
    const fields = {};
    const source = { provider: 'openai', customProvider: '', runtime: 'codex-cli', endpoint: '', credentialEnv: '', temperature: 0.3, ...(existing ? pickConfig(existing) : {}), ...values };
    const config = {};
    const text = (key, max, required = true) => {
      const raw = source[key];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if ((required && !value) || value.length > max || (raw !== undefined && typeof raw !== 'string')) {
        fields[key] = required ? `Enter ${key === 'customProvider' ? 'a provider name' : key} between 1 and ${max} characters.` : `Use no more than ${max} characters.`;
      }
      config[key] = value;
    };
    text('name', 60);
    text('role', 60);
    text('model', 120);
    text('instructions', 12000);
    config.provider = source.provider;
    if (!providerIds.has(config.provider)) fields.provider = 'Choose a supported provider or Custom provider.';
    text('customProvider', 80, config.provider === 'custom');
    if (config.provider !== 'custom') config.customProvider = '';
    config.runtime = source.runtime;
    if (!RUNTIME_TYPES.has(config.runtime)) fields.runtime = 'Choose Codex CLI, Claude Code, Ollama, or an API runtime.';
    config.departmentId = source.departmentId;
    if (existing?.isCoordinator) {
      if (config.departmentId !== 'control') fields.departmentId = 'The office coordinator belongs to the control center.';
    } else if (!departmentIds.has(config.departmentId)) fields.departmentId = 'Choose an office department.';
    if (existing && !existing.isCustom && config.departmentId !== existing.departmentId) fields.departmentId = existing.isCoordinator ? 'The office coordinator belongs to the control center.' : 'Existing employees retain their department and original seat. Add a new agent to another department instead.';
    text('endpoint', 2048, false);
    if (config.endpoint) {
      try {
        const url = new URL(config.endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid endpoint');
        config.endpoint = url.href;
      } catch { fields.endpoint = 'Enter a valid HTTP or HTTPS endpoint without embedded credentials.'; }
    }
    text('credentialEnv', 120, false);
    if (config.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(config.credentialEnv)) fields.credentialEnv = 'Enter an environment variable name such as OPENAI_API_KEY, not a secret value.';
    config.temperature = source.temperature === null || (typeof source.temperature === 'string' && !source.temperature.trim())
      ? null
      : typeof source.temperature === 'number' ? source.temperature : typeof source.temperature === 'string' ? Number(source.temperature) : NaN;
    if (config.temperature !== null && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) fields.temperature = 'Temperature must be a number from 0 to 2, or blank to use the provider default.';
    if (Object.keys(fields).length) throw failure(fields);
    return config;
  }

  function syncDerived() {
    const agents = [...originalAgents, ...added, coordinator];
    const configurations = new Map();
    const runtimeByKey = new Map();
    for (const base of baselines.values()) {
      if (baseRuntimes.some(runtime => runtime.id === base.runtimeId)) runtimeByKey.set(runtimeKey(base), base.runtimeId);
    }
    for (const agent of agents) {
      const key = runtimeKey(agent);
      let id = runtimeByKey.get(key);
      if (!id) {
        const prefix = `config-${keyHash(key)}`;
        id = prefix;
        let suffix = 1;
        while (configurations.has(id) && configurations.get(id).configurationKey !== key) id = `${prefix}-${suffix++}`;
        runtimeByKey.set(key, id);
        const provider = providers.find(item => item.id === agent.provider);
        configurations.set(id, {
          id, name: agent.provider === 'custom' ? agent.customProvider : provider.name,
          model: agent.model, kind: agent.runtime.endsWith('-cli') || agent.runtime === 'claude-code' ? 'Headless CLI' : 'Model API',
          status: 'configured', isConfigured: true, configurationKey: key,
          provider: agent.provider, customProvider: agent.customProvider, runtime: agent.runtime, endpoint: agent.endpoint,
          description: `Saved ${agent.runtime} configuration. The runtime has not been connected or verified.`,
        });
      }
      agent.runtimeId = id;
    }
    employees.splice(0, employees.length, ...originalAgents, ...added);
    runtimes.splice(0, runtimes.length, ...baseRuntimes, ...configurations.values());
    for (const department of departments) department.employees.splice(0, department.employees.length, ...employees.filter(agent => agent.departmentId === department.id).map(agent => agent.id));
  }

  function restore() {
    let raw;
    try { raw = storage?.getItem(STORAGE_KEY); } catch {
      storageWarning = 'Saved agent settings could not be read. Your current defaults are shown.';
      return;
    }
    if (!raw) return;
    let record;
    try {
      if (raw.length > 8_000_000) throw new Error('Oversized settings');
      record = JSON.parse(raw);
      if (!record || record.version !== 1 || !Array.isArray(record.overrides) || !Array.isArray(record.added)) throw new Error('Invalid settings');
    } catch {
      storageWarning = 'Saved agent settings were invalid or from an unsupported version. Defaults are shown; saving an agent will replace the invalid settings.';
      return;
    }
    let skipped = 0;
    for (const item of record.overrides) {
      const base = item && baselines.get(item.id);
      if (!base || overrides.has(item.id)) { skipped++; continue; }
      try { overrides.set(item.id, validate(pickConfig(item), base)); } catch { skipped++; }
    }
    const ids = new Set(baselines.keys());
    for (const item of record.added) {
      if (!item || typeof item.id !== 'string' || !/^custom-[a-z0-9-]{8,80}$/.test(item.id) || ids.has(item.id) || added.length >= MAX_CUSTOM_AGENTS) { skipped++; continue; }
      try {
        const config = validate(pickConfig(item));
        added.push({ ...config, id: item.id, isCustom: true, isCoordinator: false, status: 'configured', task: '' });
        ids.add(item.id);
      } catch { skipped++; }
    }
    for (const agent of [...originalAgents, coordinator]) if (overrides.has(agent.id)) Object.assign(agent, overrides.get(agent.id));
    if (skipped) storageWarning = `${skipped} invalid or duplicate saved agent ${skipped === 1 ? 'entry was' : 'entries were'} skipped. Valid settings were restored.`;
  }

  const list = () => [coordinator, ...employees];
  const get = id => id === coordinator.id ? coordinator : employees.find(agent => agent.id === id);

  function save(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure({ name: 'Enter the agent settings.' });
    const existing = values.id ? get(values.id) : undefined;
    if (values.id && !existing) throw failure({ id: 'This agent no longer exists.' });
    if (!existing && added.length >= MAX_CUSTOM_AGENTS) throw failure({ name: `This office supports up to ${MAX_CUSTOM_AGENTS} added agents.` });
    const config = validate(values, existing);
    let id = existing?.id;
    if (!id) {
      do {
        id = `custom-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`}`;
      } while (get(id));
    }
    const nextOverrides = new Map(overrides);
    let nextAdded = added;
    if (existing && !existing.isCustom) {
      if (JSON.stringify(config) === JSON.stringify(pickConfig(baselines.get(id)))) nextOverrides.delete(id);
      else nextOverrides.set(id, config);
    } else {
      const record = { ...(existing || {}), ...config, id, isCustom: true, isCoordinator: false, status: existing?.status || 'configured', task: existing?.task || '' };
      nextAdded = existing ? added.map(agent => agent.id === id ? record : agent) : [...added, record];
    }
    const persisted = {
      version: 1,
      overrides: [...nextOverrides].map(([agentId, settings]) => ({ id: agentId, ...settings })),
      added: nextAdded.map(agent => ({ id: agent.id, ...pickConfig(agent) })),
    };
    try {
      if (!storage?.setItem) throw new Error('Unavailable browser storage');
      storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      throw failure({ storage: 'Your browser could not save this configuration. Free local storage or allow site storage, then try again.' }, 'Agent settings were not saved. No agent configuration was changed.');
    }
    overrides = nextOverrides;
    if (existing) Object.assign(existing, config);
    added = nextAdded.map(agent => agent.id === existing?.id ? existing : agent);
    storageWarning = '';
    syncDerived();
    return get(id);
  }

  restore();
  syncDerived();
  return { list, get, save, departments, providers, get storageWarning() { return storageWarning; } };
}
