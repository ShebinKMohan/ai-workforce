import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlCenterBinding, controlCenterRoute, controlCenterSubmission, controlSubmissionFingerprint, consentRetryBinding, readChatState } from '../../web/claude-office/src/chat-model.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../workspace-ui/fixtures/${name}.json`, import.meta.url), 'utf8'));

function workspace() {
  const document = fixture('workspace-empty');
  document.exists = true;
  document.workspace.projects = [{ id: 'app', name: 'Developer project', repoPath: '/tmp/example/project', checks: [], archived: false }];
  document.workspace.runtimes = {
    'codex-main': { adapter: 'codex', executable: '/opt/codex-main', model: 'binding-model', effort: 'low' },
    'codex-other': { adapter: 'codex', executable: '/opt/codex-other', model: 'other-model', effort: 'high' },
  };
  document.workspace.controlCenter = { runtime: 'codex-main', model: 'model-a', effort: 'medium' };
  document.runtimes.reports = Object.entries(document.workspace.runtimes).map(([runtimeId, binding]) => ({
    runtimeId, adapter: binding.adapter, configuredExecutable: binding.executable,
    installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', usable: true,
    version: 'fixture-version', readiness: 'controllable', writeContainment: 'verified',
  }));
  return document;
}

function catalog(runtimeId = 'codex-main') {
  return {
    status: 'available', runtimeId, adapter: 'codex', configuredExecutable: `/opt/${runtimeId}`,
    defaultModel: 'model-a',
    models: [
      { id: 'model-a', label: 'Model A', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', effortStatus: 'reported' },
      { id: 'model-b', label: 'Model B', efforts: ['minimal', 'high'], defaultEffort: 'minimal', effortStatus: 'reported' },
      { id: 'binding-model', label: 'Binding model', efforts: ['low', 'medium'], defaultEffort: 'low', effortStatus: 'reported' },
      { id: 'other-model', label: 'Other model', efforts: ['high'], defaultEffort: 'high', effortStatus: 'reported' },
      { id: 'opaque-model', label: 'Opaque model', efforts: [], defaultEffort: null, effortStatus: 'unavailable' },
    ],
  };
}

describe('Control Center runtime binding', () => {
  it('allows a greeting with an active project and usable runtime before any department, worker, or check exists', () => {
    const document = workspace();
    expect(document.workspace.departments).toEqual([]);
    expect(document.workspace.agents).toEqual([]);
    expect(document.workspace.projects[0].checks).toEqual([]);
    expect(controlCenterRoute(document, 'app')).toMatchObject({ projectId: 'app', blockers: [], sendable: true });
    expect(controlCenterSubmission({ text: 'Hello', projectId: 'app', clientRequestId: 'hello-once' }, document)).toEqual({ task: 'Hello', projectId: 'app', clientRequestId: 'hello-once' });
  });

  it('inherits the workspace Control Center configuration without materializing a per-message override', () => {
    const document = workspace();
    const preferences = { runtime: '', model: '', effort: '' };
    expect(controlCenterBinding(document, preferences, catalog())).toMatchObject({
      runtimeId: 'codex-main', defaultRuntimeId: 'codex-main', runtime: document.workspace.runtimes['codex-main'],
      inheritedModel: 'model-a', inheritedEffort: 'medium', model: '', effort: '', sendable: true, blockers: [],
    });
    expect(controlCenterBinding(document, preferences, catalog()).payload).toBeUndefined();
    expect(preferences).toEqual({ runtime: '', model: '', effort: '' });
  });

  it('resolves earlier workspaces without a saved Control Center binding and inherits the chosen runtime', () => {
    const document = workspace();
    delete document.workspace.controlCenter;
    const binding = controlCenterBinding(document, {}, catalog());
    expect(binding).toMatchObject({ runtimeId: 'codex-main', defaultRuntimeId: 'codex-main', inheritedModel: 'binding-model', inheritedEffort: 'low', sendable: true });
    expect(binding.payload).toBeUndefined();
    // Installed tool discovery alone does not create a configured binding.
    document.workspace.runtimes = {};
    expect(controlCenterRoute(document, 'app').sendable).toBe(false);
  });

  it('freezes the inherited Control Center model when only the effort changes', () => {
    const binding = controlCenterBinding(workspace(), { runtime: '', model: '', effort: 'high' }, catalog());
    expect(binding).toMatchObject({ model: '', effort: 'high', inheritedModel: 'model-a', inheritedEffort: 'medium', sendable: true });
    expect(binding.payload).toEqual({ runtime: 'codex-main', model: 'model-a', effort: 'high' });
  });

  it('freezes the inherited Control Center effort when only the model changes', () => {
    const binding = controlCenterBinding(workspace(), { runtime: '', model: 'binding-model', effort: '' }, catalog());
    expect(binding.payload).toEqual({ runtime: 'codex-main', model: 'binding-model', effort: 'medium' });
    expect(binding.sendable).toBe(true);
  });

  it('inherits the selected runtime binding when an explicit runtime has no model or effort override', () => {
    const document = workspace();
    const binding = controlCenterBinding(document, { runtime: 'codex-other', model: '', effort: '' }, catalog('codex-other'));
    expect(binding).toMatchObject({ runtimeId: 'codex-other', inheritedModel: 'other-model', inheritedEffort: 'high', model: '', effort: '', sendable: true });
    expect(binding.payload).toEqual({ runtime: 'codex-other' });
    // Explicitly selecting even the same runtime means that binding's defaults.
    const sameRuntime = controlCenterBinding(document, { runtime: 'codex-main', model: '', effort: '' }, catalog());
    expect(sameRuntime).toMatchObject({ inheritedModel: 'binding-model', inheritedEffort: 'low' });
    expect(sameRuntime.payload).toEqual({ runtime: 'codex-main' });
  });

  it('shows the selected model’s reported effort levels rather than another model’s levels', () => {
    const binding = controlCenterBinding(workspace(), { model: 'model-b', effort: 'high' }, catalog());
    expect(binding.effortOptions.effectiveModel).toBe('model-b');
    expect(binding.effortOptions.options.filter(option => option.value && !option.unavailable).map(option => option.value)).toEqual(['minimal', 'high']);
    expect(binding.modelOptions.options.find(option => option.value === 'model-b')).toMatchObject({ label: 'Model B', unavailable: false });
    expect(binding.sendable).toBe(true);
  });

  it('preserves an unavailable saved selection and blocks sending instead of silently changing the model or effort', () => {
    const preferences = { runtime: '', model: 'retired-model', effort: 'unsupported-effort' };
    const before = structuredClone(preferences);
    const binding = controlCenterBinding(workspace(), preferences, catalog());
    expect(binding).toMatchObject({ model: 'retired-model', effort: 'unsupported-effort', sendable: false });
    expect(binding.modelOptions.options.find(option => option.value === 'retired-model')?.unavailable).toBe(true);
    expect(binding.effortOptions.options.find(option => option.value === 'unsupported-effort')?.unavailable).toBe(true);
    expect(binding.blockers.length).toBeGreaterThan(0);
    expect(preferences).toEqual(before);
  });

  it('blocks an inherited configured model when fresh discovery proves it is unavailable', () => {
    const document = workspace();
    document.workspace.controlCenter.model = 'retired-model';
    const binding = controlCenterBinding(document, {}, catalog());
    expect(binding).toMatchObject({ model: '', inheritedModel: 'retired-model', sendable: false });
    expect(document.workspace.controlCenter.model).toBe('retired-model');
    expect(controlCenterBinding(document, { model: 'model-a' }, catalog()).sendable).toBe(true);
  });

  it('requires correcting an inherited effort that the selected model explicitly cannot use', () => {
    const binding = controlCenterBinding(workspace(), { model: 'model-b', effort: '' }, catalog());
    expect(binding.effortOptions.inheritedUnavailable).toBe(true);
    expect(binding.effortOptions.options.find(option => option.value === '')?.unavailable).toBe(true);
    expect(binding.sendable).toBe(false);
    expect(controlCenterBinding(workspace(), { model: 'model-b', effort: 'high' }, catalog()).sendable).toBe(true);
  });

  it('keeps configured defaults usable when model discovery is unavailable but blocks an unconfirmed explicit selection', () => {
    const unavailable = { ...catalog(), status: 'unavailable', diagnostics: ['Model discovery did not complete.'] };
    expect(controlCenterBinding(workspace(), {}, unavailable)).toMatchObject({ inheritedModel: 'model-a', inheritedEffort: 'medium', sendable: true });
    const override = controlCenterBinding(workspace(), { model: 'model-a' }, unavailable);
    expect(override).toMatchObject({ model: 'model-a', sendable: false });
    expect(override.modelOptions.options.find(option => option.value === 'model-a')?.unavailable).toBe(true);
    expect(controlCenterBinding(workspace(), { effort: 'high' }, { ...catalog(), status: 'loading' }).sendable).toBe(false);
  });

  it.each([null, { status: 'loading', models: [] }])('waits for cold discovery without labeling saved model or effort choices invalid: %j', pendingCatalog => {
    const preferences = { runtime: 'codex-main', model: 'model-a', effort: 'low' };
    const pending = controlCenterBinding(workspace(), preferences, pendingCatalog);
    expect(pending).toMatchObject({ loading: true, blockers: [], sendable: false, model: 'model-a', effort: 'low' });
    expect(pending.modelOptions).toMatchObject({ disabled: true, hint: 'Reading runtime models…' });
    expect(pending.modelOptions.options.find(option => option.value === 'model-a')).toMatchObject({ label: 'model-a · loading', unavailable: false });
    expect(pending.effortOptions.disabled).toBe(true);
    expect(pending.effortOptions.options.find(option => option.value === 'low')).toMatchObject({ label: 'low · loading', unavailable: false });
    expect(controlCenterBinding(workspace(), preferences, catalog())).toMatchObject({ loading: false, sendable: true, blockers: [] });
    expect(controlCenterBinding(workspace(), preferences, { status: 'unavailable', models: [] }).blockers.join(' ')).toContain('Model choices are unavailable');
    expect(preferences).toEqual({ runtime: 'codex-main', model: 'model-a', effort: 'low' });
  });

  it('does not invent reasoning choices for a model whose runtime reports no effort catalog', () => {
    const binding = controlCenterBinding(workspace(), { model: 'opaque-model' }, catalog());
    expect(binding.effortOptions.effectiveModel).toBe('opaque-model');
    expect(binding.effortOptions.options.filter(option => option.value && !option.unavailable)).toEqual([]);
    expect(binding.effortOptions.disabled).toBe(true);
  });

  it('blocks a missing or unavailable exact runtime binding without borrowing a working installation’s status', () => {
    const document = workspace();
    expect(controlCenterBinding(document, { runtime: 'removed-runtime' }, catalog())).toMatchObject({ runtimeId: 'removed-runtime', sendable: false });
    const exact = document.runtimes.reports.find(report => report.runtimeId === 'codex-main');
    exact.usable = false;
    exact.auth = 'logged_out';
    document.runtimes.reports.push({ ...exact, runtimeId: undefined, configuredExecutable: undefined, auth: 'logged_in', usable: true });
    expect(controlCenterRoute(document, 'app')).toMatchObject({ sendable: false });
    expect(controlCenterBinding(document, {}, catalog()).sendable).toBe(false);
    expect(() => controlCenterSubmission({ text: 'Hello', projectId: 'app' }, document)).toThrow();
  });

  it('requires an active registered project even for a greeting', () => {
    const document = workspace();
    document.workspace.projects[0].archived = true;
    expect(controlCenterRoute(document, 'app').sendable).toBe(false);
    expect(() => controlCenterSubmission({ text: 'Hello', projectId: 'app' }, document)).toThrow();
    expect(controlCenterRoute(workspace(), 'removed-project').sendable).toBe(false);
    expect(controlCenterRoute(null).sendable).toBe(false);
  });
});

describe('Control Center submission and retry identity', () => {
  it('sends only the selected runtime, model, and effort while keeping agent and canvas selection out of routing', () => {
    const document = workspace();
    const payload = controlCenterSubmission({
      text: 'Explain the project', projectId: 'app', clientRequestId: 'binding-once',
      agentId: 'unrelated-agent', departmentId: 'unrelated-department', selection: { type: 'employee', id: 'unrelated-agent' },
      controlCenter: { runtime: 'codex-other', model: 'other-model', effort: 'high', agentId: 'unrelated-agent', instructions: 'Unexpected override' },
    }, document);
    expect(payload).toEqual({ task: 'Explain the project', projectId: 'app', clientRequestId: 'binding-once', controlCenter: { runtime: 'codex-other', model: 'other-model', effort: 'high' } });
  });

  it.each([
    { runtime: 'removed-runtime' },
    { runtime: 42 },
    { runtime: ['codex-main'] },
    { runtime: 'codex-main', model: 42 },
    { runtime: 'codex-main', model: null },
    { runtime: 'codex-main', effort: true },
    { runtime: 'codex-main', effort: ['high'] },
    'codex-main',
    [],
    null,
  ])('rejects an invalid binding before submitting: %j', controlCenter => {
    expect(() => controlCenterSubmission({ text: 'Hello', projectId: 'app', controlCenter }, workspace())).toThrow();
  });

  it('keeps the fingerprint stable for reordered binding keys while distinguishing task, project, and binding changes', () => {
    const context = { text: 'Investigate the parser', projectId: 'app', controlCenter: { runtime: 'codex-main', model: 'model-a', effort: 'high' } };
    const original = controlSubmissionFingerprint(context);
    expect(controlSubmissionFingerprint({ projectId: 'app', controlCenter: { effort: 'high', model: 'model-a', runtime: 'codex-main' }, text: context.text })).toEqual(original);
    for (const controlCenter of [undefined, { ...context.controlCenter, runtime: 'codex-other' }, { ...context.controlCenter, model: 'model-b' }, { ...context.controlCenter, effort: 'low' }]) {
      expect(controlSubmissionFingerprint({ ...context, controlCenter })).not.toEqual(original);
    }
    expect(controlSubmissionFingerprint({ ...context, projectId: 'other-project' })).not.toEqual(original);
    expect(controlSubmissionFingerprint({ ...context, text: 'Investigate the renderer' })).not.toEqual(original);
  });

  it('restores blank inheritance choices and an uncertain submission identity without rewriting saved preferences', () => {
    const saved = { version: 1, contexts: { control: { draft: 'Keep this pending task', projectId: 'app', controlCenter: { runtime: '', model: '', effort: 'high' }, submission: { id: 'uncertain-submit', fingerprint: 'saved-binding-fingerprint' } } }, messages: [] };
    const restored = readChatState({ getItem: () => JSON.stringify(saved) }, 'test-workspace');
    expect(restored.contexts.control).toEqual(saved.contexts.control);
    const preferences = restored.contexts.control.controlCenter;
    const binding = controlCenterBinding(workspace(), preferences, catalog());
    expect(binding.payload).toEqual({ runtime: 'codex-main', model: 'model-a', effort: 'high' });
    expect(restored.contexts.control).toEqual(saved.contexts.control);
  });

  it.each([undefined, { runtime: 'codex-main' }])('retries consent with the originally resolved settings when defaults have changed: %j', submittedControlCenter => {
    const document = workspace();
    document.workspace.runtimes['codex-main'].model = 'new-default-model';
    document.workspace.runtimes['codex-main'].effort = 'high';
    document.workspace.controlCenter.model = 'new-global-model';
    const request = { submittedControlCenter, controlCenter: { runtime: 'codex-main', model: 'original-model', effort: 'low', instructions: 'Frozen instructions', projectRoutes: [] } };
    const selected = consentRetryBinding(request, { runtime: 'codex-other', model: 'other-model' });
    expect(selected).toEqual({ runtime: 'codex-main', model: 'original-model', effort: 'low' });
    expect(controlCenterSubmission({ text: 'Original task', projectId: 'app', clientRequestId: 'consent-once', allowUnconfinedWrites: true, controlCenter: selected }, document)).toMatchObject({ controlCenter: selected, clientRequestId: 'consent-once', allowUnconfinedWrites: true });
  });

  it('preserves an already-attempted consent binding exactly on uncertain HTTP retries', () => {
    const original = { runtime: 'codex-main', model: 'original-model', effort: 'low' };
    const previous = { id: 'uncertain-consent', controlCenter: original };
    const request = { controlCenter: { runtime: 'codex-other', model: 'changed-model', effort: 'high' } };
    expect(consentRetryBinding(request, { runtime: 'codex-other' }, previous)).toBe(original);
    expect(previous.id).toBe('uncertain-consent');
    // An older attempted request which omitted the override must remain omitted.
    expect(consentRetryBinding(request, null, { id: 'legacy-uncertain' })).toBeUndefined();
    expect(consentRetryBinding({ submittedControlCenter: original }, null, 'legacy-request-id')).toEqual(original);
  });
});
