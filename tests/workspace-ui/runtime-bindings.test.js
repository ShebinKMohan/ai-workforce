import { describe, expect, it } from 'vitest';
import { agentTool, indexWorkspace, runtimeBoundary, toolFact, toolRows } from '../../web/workspace/src/model.js';
import { applyLiveDocuments } from '../../web/claude-office/src/live-data.js';
import { fixture } from './support.js';

function workspace() {
  const doc = fixture('workspace.json');
  doc.workspace.runtimes = {
    'codex-local': { adapter: 'codex', executable: 'codex' },
    'codex-custom': { adapter: 'codex', executable: '/missing/codex' },
  };
  const installed = { adapter: 'codex', installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', version: '0.147.0', executable: '/usr/local/bin/codex', writeContainment: 'verified' };
  doc.runtimes.reports = [
    installed,
    { ...installed, runtimeId: 'codex-local', configuredExecutable: 'codex' },
    { ...installed, runtimeId: 'codex-custom', configuredExecutable: '/missing/codex', installed: false, executable: null, version: null },
  ];
  return doc;
}

describe('runtime identity remains intact from API reports to visible agent and connection state', () => {
  it('a broken custom binding cannot replace generic discovery or borrow its signed-in state', () => {
    const ws = indexWorkspace(workspace());
    expect(toolFact(ws, 'codex')).toMatchObject({ ready: true, word: 'signed in', version: '0.147.0' });
    expect(agentTool(ws, { runtime: 'codex-local' })).toMatchObject({ ready: true, word: 'signed in' });
    expect(agentTool(ws, { runtime: 'codex-custom' })).toMatchObject({ ready: false, word: 'not found', version: null });
    expect(toolRows(ws)).toHaveLength(1);
    const state = applyLiveDocuments(ws.doc, fixture('runs-empty.json'), fixture('requests-empty.json'));
    expect(state.runtimes.find((runtime) => runtime.id === 'codex-custom')).toMatchObject({ ready: false, connectionLabel: 'not found', report: { runtimeId: 'codex-custom' } });
    expect(state.runtimes.find((runtime) => runtime.id === 'codex-local')).toMatchObject({ ready: true, connectionLabel: 'signed in' });
    expect(state.runtimes.filter((runtime) => runtime.configured)).toHaveLength(2);
  });

  it('a changed executable stays unconfirmed until its own report arrives, while old default-command payloads still work', () => {
    const doc = workspace();
    doc.workspace.runtimes['codex-custom'].executable = 'codex';
    expect(agentTool(indexWorkspace(doc), { runtime: 'codex-custom' })).toMatchObject({ ready: null, word: 'not checked' });
    doc.runtimes.reports = doc.runtimes.reports.filter((report) => !report.runtimeId);
    expect(agentTool(indexWorkspace(doc), { runtime: 'codex-local' })).toMatchObject({ ready: true });
    doc.workspace.runtimes['codex-custom'].executable = '/different/codex';
    expect(agentTool(indexWorkspace(doc), { runtime: 'codex-custom' })).toMatchObject({ ready: null, word: 'not checked' });
  });

  it('unavailable controls and an untested write boundary cannot be shown as ready and verified', () => {
    const doc = workspace();
    doc.runtimes.reports[1].controllable = false;
    expect(agentTool(indexWorkspace(doc), { runtime: 'codex-local' })).toMatchObject({ ready: false, word: 'runtime controls unavailable' });
    doc.runtimeRules['codex-local'] = { adapter: 'codex', executable: 'codex', writeContainment: 'verified', requiresWriteConsent: true, installedVersion: '0.160.0', testedVersion: '0.147.0', runsOnItsOwn: false };
    expect(runtimeBoundary(indexWorkspace(doc), 'codex-local')).toMatchObject({ verified: false, requiresWriteConsent: true, installedVersion: '0.160.0', testedVersion: '0.147.0' });
    doc.workspace.runtimes['codex-local'].executable = '/unconfirmed/codex';
    expect(runtimeBoundary(indexWorkspace(doc), 'codex-local')).toMatchObject({ containment: 'unknown', verified: false, requiresWriteConsent: true });
  });
});
