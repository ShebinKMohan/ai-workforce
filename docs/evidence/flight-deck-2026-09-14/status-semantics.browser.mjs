// Deterministic browser fixture; no server, runtime invocation or saved workspace changes.
// Run: node docs/evidence/flight-deck-2026-09-14/status-semantics.browser.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderTaskRailSummary } from '../../../web/headquarters/src/headquarters/task-rail.js';

const modulePath = process.env.WORKFORCE_PLAYWRIGHT_MODULE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(modulePath).href);
const executablePath = process.env.WORKFORCE_BROWSER_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const frontend = new URL('../../../web/headquarters/src/headquarters/', import.meta.url);
const index = readFileSync(new URL('index.html', frontend), 'utf8');
const styles = [...index.matchAll(/href="\/src\/headquarters\/([^"]+\.css)"/g)]
  .map(([, file]) => `<style>${readFileSync(new URL(file, frontend), 'utf8')}</style>`).join('');
const request = { id: 'request', runId: 'run', projectId: 'project', state: 'running', task: 'Review fixture status', route: { state: 'selected', departmentId: 'engineering' } };
const run = { id: 'run', projectId: 'project', state: 'running', taskViews: [{ id: 'task', state: 'running', ownerAgentId: 'worker' }] };
const context = { request, run, projects: [{ id: 'project', name: 'Status fixture' }], departments: [{ id: 'engineering', headAgentId: 'head' }], agents: [{ id: 'worker', name: 'Worker' }, { id: 'head', name: 'Head' }] };
const ended = { ...request, state: 'ended', exitCode: 0 };
const checkedRun = { ...run, state: 'ready_for_review', outcome: { accepted: true, requiredTotal: 2, requiredPassed: 2 }, headReview: { state: 'passed' } };
const fixtures = [
  { id: 'missing', input: context, status: 'Working', checks: 'No completed verification recorded yet' },
  { id: 'failed', input: { ...context, request: { ...request, state: 'ended', exitCode: 4 }, run: { ...run, state: 'failed', outcome: { accepted: false, requiredTotal: 2, requiredPassed: 0 } } }, status: 'Needs attention', checks: '0 of 2 required checks passed' },
  { id: 'disconnected', input: { ...context, connected: false }, status: 'Connection lost · last received status', checks: 'No completed verification recorded yet' },
  { id: 'cancelled', input: { ...context, request: { ...request, state: 'cancelled' } }, status: 'Stopped', checks: 'No completed verification recorded yet' },
  { id: 'review-pending', input: { ...context, request: ended, run: { ...checkedRun, headReview: null } }, status: 'Review not recorded', checks: '2 of 2 required checks passed' },
  { id: 'verified', input: { ...context, request: ended, run: checkedRun }, status: 'Verified', checks: '2 of 2 required checks passed', complete: true },
  { id: 'analysis-pending', input: { ...context, run: { ...run, workKind: 'analysis' } }, status: 'Working', checks: 'Read-only analysis · report evidence pending' },
  { id: 'reviewed-analysis', input: { ...context, request: ended, run: { ...checkedRun, workKind: 'analysis', outcome: { accepted: false }, analysis: { reviewed: true, sourceUnchanged: true, reportCount: 1, evidenceIssues: [] } } }, status: 'Reviewed analysis', checks: '1 reviewed report · code unchanged', complete: true },
];

const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  for (const theme of ['light', 'dark']) {
    const markup = fixtures.map(fixture => `<div id="${fixture.id}" class="live-control-chat">${renderTaskRailSummary(fixture.input)}</div>`).join('');
    await page.setContent(`<html data-theme="${theme}"><head>${styles}</head><body>${markup}<i id="success-token" style="color:var(--green);background:var(--success-light)"></i><i id="active-token" style="background:var(--accent-light)"></i></body></html>`);
    const result = await page.evaluate(() => {
      const success = getComputedStyle(document.querySelector('#success-token'));
      return {
        successColor: success.color, successBackground: success.backgroundColor,
        activeBackground: getComputedStyle(document.querySelector('#active-token')).backgroundColor,
        rows: [...document.querySelectorAll('.live-control-chat')].map(element => {
          const status = element.querySelector('.cc-work-summary-top > strong');
          const checks = element.querySelector('.cc-check-summary');
          return { id: element.id, status: status.textContent, checks: checks.textContent, background: getComputedStyle(status).backgroundColor, color: getComputedStyle(checks).color };
        }),
      };
    });
    for (const fixture of fixtures) {
      const row = result.rows.find(item => item.id === fixture.id);
      assert.equal(row.status, fixture.status, `${theme}/${fixture.id}: recorded status`);
      assert.equal(row.checks, fixture.checks, `${theme}/${fixture.id}: evidence text`);
      if (fixture.complete) {
        assert.equal(row.color, result.successColor, `${theme}/${fixture.id}: completed evidence stays green`);
        assert.equal(row.background, result.successBackground, `${theme}/${fixture.id}: completed result stays green`);
      } else {
        assert.notEqual(row.color, result.successColor, `${theme}/${fixture.id}: incomplete evidence must not look successful`);
        assert.notEqual(row.background, result.successBackground, `${theme}/${fixture.id}: incomplete status must not look successful`);
      }
      if (fixture.status === 'Working') assert.equal(row.background, result.activeBackground, `${theme}/${fixture.id}: working status uses the active color`);
    }
    console.log(JSON.stringify({ theme, passed: fixtures.length, rows: result.rows }));
  }
} finally {
  await browser.close();
}
