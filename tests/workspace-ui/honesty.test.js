/**
 * The honesty contract, held against the pages as rendered from real server
 * documents:
 * - green (tone-verified) only where a verifier-executed passing receipt backs it;
 * - the honesty functions keep the meaning they had in web/office;
 * - no percentages, no invented activity, empty shown as empty;
 * - plain words on primary screens: record words, ids and hashes only inside "Show record".
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as office from '../../web/office/src/office-model.js';
import * as truth from '../../web/workspace/src/truth.js';
import { findEntry, taskDetailModel } from '../../web/workspace/src/model.js';
import { renderHome } from '../../web/workspace/src/pages/home.js';
import { renderTasks } from '../../web/workspace/src/pages/tasks.js';
import { renderTask } from '../../web/workspace/src/pages/task.js';
import { renderNewTaskSheet, sheetDefaults } from '../../web/workspace/src/sheets/new-task.js';
import { addProjectDefaults, renderAddProjectSheet } from '../../web/workspace/src/sheets/add-project.js';
import { clone, contextFor, fixture, uiState, visibleText } from './support.js';

function taskPage(name, { runs = fixture('runs.json'), requests = fixture('requests.json'), mutate, expanded = [] } = {}) {
  const runsDoc = clone(runs);
  if (mutate) mutate(runsDoc);
  const ui = uiState({ expanded: new Set(expanded) });
  const ctx = contextFor(fixture('workspace.json'), runsDoc, requests, { ui });
  const status = fixture(`status-${name}.json`);
  const events = fixture(`events-${name}.json`).events;
  const route = { name: 'task', projectId: 'app', runId: status.run.id };
  const entry = findEntry(ctx.entries, route) ?? ctx.entries.find((candidate) => candidate.runId === status.run.id);
  const detail = taskDetailModel({ ws: ctx.ws, entry, status, events, now: ctx.now });
  return renderTask({ ...ctx, route, taskView: { entry, detail, status, events, loading: false, error: null } });
}

/** Every primary screen, rendered from real documents, with every disclosure open. */
function primaryScreens() {
  const all = ['phase:send', 'phase:decide', 'phase:change', 'phase:check', 'phase:review', 'checks', 'events', 'changes'];
  const screens = {
    'home, empty': renderHome(contextFor(fixture('workspace-empty.json'), fixture('runs-empty.json'), fixture('requests-empty.json'))),
    'home, setup': renderHome(contextFor(fixture('workspace-starter.json'), fixture('runs-empty.json'), fixture('requests-empty.json'))),
    'home, built': renderHome(contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'))),
    'home, live': renderHome(contextFor(fixture('workspace.json'), fixture('runs-live.json'), fixture('requests-queued.json'))),
    'home, held': renderHome(contextFor(fixture('workspace.json'), fixture('runs-live.json'), fixture('requests-held.json'))),
    tasks: renderTasks(contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'))),
  };
  for (const name of ['verified', 'rejected', 'interrupted', 'page']) screens[`task ${name}`] = taskPage(name, { expanded: all });
  screens['task live'] = taskPage('live', { runs: fixture('runs-live.json'), requests: fixture('requests-live.json'), expanded: all });
  const live = contextFor(fixture('workspace.json'), fixture('runs-live.json'), fixture('requests-live.json'));
  screens['new task sheet'] = renderNewTaskSheet(live, { ...sheetDefaults(live.ws), text: 'Add docs' });
  screens['add project sheet'] = renderAddProjectSheet(live, { ...addProjectDefaults(), inspection: fixture('inspect-storefront.json'), projectName: 'storefront' });
  return screens;
}

describe('green means verified, and nothing else', () => {
  it('a verified task page has green; the same page without verifier receipts has none', () => {
    expect(taskPage('verified')).toContain('tone-verified');
    const stripped = taskPage('verified', {
      mutate: (runs) => {
        for (const run of runs.runs) for (const task of run.taskViews) task.receipts = { ...task.receipts, verifierExecutedPassed: 0 };
      },
      expanded: ['phase:check', 'phase:review', 'checks'],
    });
    // Check rows the verifier ran and passed are still green on their own row; no part, verdict or result is.
    expect(visibleText(stripped)).not.toContain('Verified:');
    expect(stripped).not.toMatch(/stage-line tone-verified[^"]*"><span class="tone-icon" aria-hidden="true">✓<\/span>(Verified|Ready)/);
  });

  it('a task whose plan was never usable, and a stopped task\'s unfinished part, carry no green verdict', () => {
    expect(taskPage('rejected', { expanded: ['phase:decide', 'phase:review'] })).not.toContain('tone-verified');
    const stopped = visibleText(taskPage('interrupted', { expanded: ['phase:review'] }));
    expect(stopped).toContain('Stopped before it finished');
    expect(stopped).not.toContain('Ready for your review');
  });

  it('a compromised receipt is never drawn green', () => {
    const status = clone(fixture('status-verified.json'));
    const receipt = status.checks[0];
    status.requirements = [{ criterionId: 'check-1', status: 'compromised', receiptId: receipt.id, required: true }];
    expect(truth.checkView(receipt, status).tone).toBe('compromised');
  });
});

describe('the honesty functions keep their meaning from web/office', () => {
  const runs = fixture('runs.json').runs;
  const live = fixture('runs-live.json').runs;
  const free = { held: false, pid: null, acquiredAt: null, holder: null };
  const held = { held: true, pid: 1, acquiredAt: 'x', holder: 'alive' };
  const statuses = ['verified', 'rejected', 'interrupted', 'page', 'live'].map((name) => fixture(`status-${name}.json`));

  it('gives the same answers on real payloads', () => {
    for (const run of [...runs, ...live]) {
      for (const lock of [null, free, held]) {
        expect(truth.isStalledRun(run, lock)).toBe(office.isStalledRun(run, lock));
        expect(truth.runTone(run, lock)).toBe(office.runTone(run, lock));
        expect(truth.runStatusLine(run, lock)).toBe(office.runStatusLine(run, lock));
        for (const agent of ['nova', 'mira', 'atlas']) expect(truth.deskState(agent, [run], lock)).toEqual(office.deskState(agent, [run], lock));
      }
      expect(truth.failureReason(run)).toBe(office.failureReason(run));
      for (const task of run.taskViews) expect(truth.isVerifiedTask(task)).toBe(office.isVerifiedTask(task));
    }
    for (const status of statuses) {
      expect(truth.acceptanceView(status, free)).toEqual(office.acceptanceView(status, free));
      expect(truth.requirementViews(status)).toEqual(office.requirementViews(status));
      for (const check of status.checks) expect(truth.checkView(check, status)).toEqual(office.checkView(check, status));
    }
    for (const event of fixture('events-verified.json').events) expect(truth.describeEvent(event)).toBe(office.describeEvent(event));
    const report = fixture('workspace.json').runtimes.reports[1];
    expect(truth.runtimeStatus({ ...report, controllable: true })).toEqual(office.runtimeStatus({ ...report, controllable: true }));
  });
});

describe('primary screens say only what is recorded, in plain words', () => {
  const screens = primaryScreens();
  const FORBIDDEN = [/\brequests?\b/i, /\bruntimes?\b/i, /\bcoordinator\b/i, /\bcandidates?\b/i, /\bworktrees?\b/i, /\bbranch(es)?\b/i, /\bexit code\b/i, /\bpid\b/i, /\bsessions?\b/i, /\bepoch\b/i, /\bcompromised\b/i, /\bcombining\b/i, /\beligible\b/i, /\bdependency\b/i, /\baccepted\b/i, /\bslots?\b/i, /\bwriters?\b/i, /\bturns?\b/i, /\bthis run\b/i, /\brun [0-9a-f]{6,}/i];
  const HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/i;

  for (const [name, html] of Object.entries(screens)) {
    it(`${name}: no record word, id or hash outside "Show record"`, () => {
      const text = visibleText(html);
      expect(text.length).toBeGreaterThan(20);
      for (const pattern of FORBIDDEN) expect({ name, pattern: String(pattern), match: text.match(pattern)?.[0] ?? null }).toEqual({ name, pattern: String(pattern), match: null });
      expect({ name, hex: text.match(HEX)?.[0] ?? null }).toEqual({ name, hex: null });
    });
  }

  it('shows no percentages or progress bars anywhere', () => {
    for (const [name, html] of Object.entries(screens)) {
      expect({ name, percent: /\d\s*%/.test(visibleText(html)) }).toEqual({ name, percent: false });
      expect(html).not.toMatch(/<progress|role="progressbar"/);
    }
  });

  it('an empty workspace shows no people, tasks or activity', () => {
    const text = visibleText(screens['home, empty']);
    expect(screens['home, empty']).not.toContain('class="desk ');
    expect(text).not.toMatch(/Working|Available|in motion ·/);
    expect(text).toContain('No departments yet');
  });
});

describe('the served page carries no invented activity', () => {
  const ROOT = fileURLToPath(new URL('../../web/workspace/', import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const sources = files(ROOT).filter((file) => /\.(js|css|html)$/.test(file));

  it('has no demo data, sample people, timers that draw activity, or storage of agents', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of ['Maya Chen', 'Acme', 'SAMPLE', 'demo activity', 'Demo activity', 'Math.random', 'progress-bar']) expect({ file, phrase, found: text.includes(phrase) }).toEqual({ file, phrase, found: false });
      expect({ file, storesAgents: /localStorage\.setItem\([^)]*agent/i.test(text) }).toEqual({ file, storesAgents: false });
    }
  });

  it('starts work from exactly one place: the New task sheet, through POST /api/requests', () => {
    const callers = sources.filter((file) => /api\.send\(/.test(readFileSync(file, 'utf8')));
    expect(callers.map((file) => path.relative(ROOT, file))).toEqual(['src/app.js']);
    expect(readFileSync(path.join(ROOT, 'src', 'api.js'), 'utf8')).toContain("postJson('/api/requests', body)");
  });
});
