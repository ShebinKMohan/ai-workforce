import { describe, expect, it } from 'vitest';
import { OFFICE_TABS, officeTaskGroups, renderControlCenter } from '../../web/workspace/src/pages/office.js';
import { contextFor, fixture, uiState, visibleText } from './support.js';

function context(tab = 'assign') {
  return contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'), { ui: uiState({ officeTab: tab }) });
}

describe('the selected Control center uses real workspace records', () => {
  it('offers Assign, Tasks and Connections, with a draft that opens normal task review', () => {
    const ctx = context();
    ctx.ui.officeDraft = 'Fix <script>alert(1)</script> safely';
    const html = renderControlCenter(ctx);
    expect(OFFICE_TABS).toEqual(['assign', 'tasks', 'connections']);
    expect(html).toContain('data-action="office-compose"');
    expect(html).toContain('Review project, team and checks before sending.');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/data-action="send-task"|local demo|sample tasks|chat-message-assistant/i);
  });

  it('keeps setup incomplete rather than exposing a send control', () => {
    const ctx = contextFor(fixture('workspace-empty.json'), fixture('runs-empty.json'), fixture('requests-empty.json'));
    const html = renderControlCenter(ctx);
    expect(html).toContain('Finish workspace setup');
    expect(html).not.toContain('data-action="office-compose"');
  });

  it('displays a ready-for-review task once instead of duplicating it in Finished', () => {
    const ctx = context('tasks');
    const verified = ctx.entries.find((entry) => entry.status.key === 'verified');
    const groups = officeTaskGroups(ctx);
    expect(groups.review.some((entry) => entry.href === verified.href)).toBe(true);
    expect(groups.finished.some((entry) => entry.href === verified.href)).toBe(false);
    const html = renderControlCenter(ctx);
    expect(html.split(`href="${verified.href}"`).length - 1).toBe(1);
  });

  it('does not mix another department held task into the selected department attention list', () => {
    const ctx = context('tasks');
    ctx.ui.officeDepartmentId = 'eng';
    ctx.entries = [
      { href: '#/tasks/q/engineering', departmentId: 'eng', item: { state: 'held' } },
      { href: '#/tasks/q/design', departmentId: 'design', item: { state: 'held' } },
    ];
    ctx.needs.items = [
      { href: '#/tasks/q/engineering', kind: 'held', runId: null },
      { href: '#/tasks/q/design', kind: 'held', runId: null },
      { href: '#/settings', kind: 'tool', runId: null },
    ];
    expect(officeTaskGroups(ctx).review.map((item) => item.href)).toEqual(['#/tasks/q/engineering', '#/settings']);
  });

  it('shows passive sign-in uncertainty and inherited configured models without claiming a live connection', () => {
    const ctx = context('connections');
    const report = ctx.ws.reports.find((report) => report.adapter === 'codex');
    report.auth = 'unknown';
    ctx.ws.config.runtimes['test-codex'] = { adapter: 'codex', model: 'configured-on-runtime' };
    const agent = ctx.ws.liveAgents[0];
    agent.runtime = 'test-codex';
    delete agent.model;
    ctx.ws.toolsError = 'Probe timed out';
    const html = renderControlCenter(ctx);
    const text = visibleText(html);
    expect(text).toContain('sign-in not confirmed');
    expect(text).toContain('configured-on-runtime');
    expect(text).toContain('Last checked');
    expect(text).toContain('Could not refresh coding tools: Probe timed out');
    expect(text).not.toMatch(/verified connection|connected to model|models connected/i);
  });
});
