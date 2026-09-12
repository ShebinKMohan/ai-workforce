/** Rendering helpers: the keyed patch plan, escaping, routes and project chips. */
import { describe, expect, it } from 'vitest';
import { esc, keyed, planPatch, sig } from '../../web/workspace/src/render.js';
import { parseRoute, routeKey } from '../../web/workspace/src/routes.js';
import { projectMonograms } from '../../web/workspace/src/model.js';

describe('planPatch', () => {
  const nodes = (...pairs) => pairs.map(([key, value]) => ({ key, sig: value }));

  it('leaves unchanged keys alone and replaces only changed ones', () => {
    const ops = planPatch(nodes(['a', '1'], ['b', '1'], ['c', '1']), nodes(['a', '1'], ['b', '2'], ['c', '1']));
    expect(ops.map((op) => `${op.op}:${op.key}`)).toEqual(['keep:a', 'replace:b', 'keep:c']);
  });

  it('never replaces or removes the node that holds focus: it defers instead', () => {
    expect(planPatch(nodes(['a', '1'], ['form', '1']), nodes(['a', '2'], ['form', '2']), 'form').map((op) => `${op.op}:${op.key}`)).toEqual(['replace:a', 'defer:form']);
    expect(planPatch(nodes(['a', '1'], ['form', '1']), nodes(['a', '1']), 'form').map((op) => `${op.op}:${op.key}`)).toEqual(['keep:a', 'defer:form']);
  });

  it('inserts new keys at their position and removes keys that are gone', () => {
    const ops = planPatch(nodes(['a', '1'], ['c', '1']), nodes(['a', '1'], ['b', '1']));
    expect(ops.map((op) => `${op.op}:${op.key}:${op.index}`)).toEqual(['keep:a:0', 'insert:b:1', 'remove:c:-1']);
  });

  it('keyed blocks carry a signature of what they were rendered from', () => {
    expect(keyed('li', 'x', 'class="row"', 'same')).toBe(keyed('li', 'x', 'class="row"', 'same'));
    expect(keyed('li', 'x', '', 'one')).not.toBe(keyed('li', 'x', '', 'two'));
    expect(sig('a')).not.toBe(sig('b'));
  });

  it('escapes text and attributes', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });
});

describe('routes', () => {
  it('parses every page, including a task sent from this page and one started elsewhere', () => {
    expect(parseRoute('')).toMatchObject({ name: 'home' });
    expect(parseRoute('#/office')).toMatchObject({ name: 'office' });
    expect(parseRoute('#/tasks')).toMatchObject({ name: 'tasks' });
    expect(parseRoute('#/tasks/q/0190-abc')).toMatchObject({ name: 'task', requestId: '0190-abc' });
    expect(parseRoute('#/tasks/app/0190-run')).toMatchObject({ name: 'task', projectId: 'app', runId: '0190-run' });
    expect(parseRoute('#/projects/app')).toMatchObject({ name: 'project', projectId: 'app' });
    expect(parseRoute('#/departments/new')).toMatchObject({ name: 'department', departmentId: null });
    expect(parseRoute('#/departments/eng?agent=nova')).toMatchObject({ name: 'department', departmentId: 'eng', params: { agent: 'nova' } });
    expect(parseRoute('#/settings')).toMatchObject({ name: 'settings' });
    expect(routeKey(parseRoute('#/tasks/app/r1'))).toBe('task/app/r1');
  });
});

describe('project chips', () => {
  it('follow the monogram rule: two words give initials, one word its first two letters, a taken chip the next letter, archived projects included', () => {
    const chips = projectMonograms([
      { id: 'billing-api', name: 'billing-api' },
      { id: 'checkout', name: 'checkout', archived: true },
      { id: 'chat', name: 'chat' },
      { id: 'docs', name: 'docs' },
      { id: 'cc', name: 'c' },
    ]);
    expect(Object.fromEntries(chips)).toEqual({ 'billing-api': 'BA', checkout: 'CH', chat: 'CA', docs: 'DO', cc: 'C2' });
  });
});
