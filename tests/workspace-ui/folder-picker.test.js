import { describe, expect, it } from 'vitest';
import { createFolderPicker, folderBreadcrumbs, renderFolderPicker } from '../../web/workspace/src/folder-picker.js';
import { addProjectDefaults, renderAddProjectSheet } from '../../web/workspace/src/sheets/add-project.js';
import { contextFor, fixture } from './support.js';

const listing = { ok: true, currentPath: '/Users/developer/code', parentPath: '/Users/developer', isGitRepository: false, places: [{ label: 'Home', path: '/Users/developer' }], folders: [{ name: 'My app', path: '/Users/developer/code/My app', isGitRepository: true }], truncated: false };

describe('local folder picker navigation and selection', () => {
  it('shows the current location, git folder information, filtering, and a path fallback', () => {
    const html = renderFolderPicker({ listing, loading: false, query: '', error: null });
    expect(folderBreadcrumbs('/Users/developer/code')).toEqual([{ name: 'Computer', path: '/' }, { name: 'Users', path: '/Users' }, { name: 'developer', path: '/Users/developer' }, { name: 'code', path: '/Users/developer/code' }]);
    expect(html).toContain('My app');
    expect(html).toContain('<small>Git</small>');
    expect(html).toContain('Use this folder');
    expect(renderFolderPicker({ listing, loading: false, query: 'missing', error: null })).toContain('No folders match');
    const sheet = renderAddProjectSheet(contextFor(fixture('workspace.json'), fixture('runs-empty.json'), fixture('requests-empty.json')), addProjectDefaults());
    expect(sheet.indexOf('Browse folders')).toBeLessThan(sheet.indexOf('Enter a path'));
    expect(sheet).toContain('<details class="project-path-fallback">');
  });

  it('selects the canonical current folder only after loading without committing registration', async () => {
    const selected = [];
    const requests = [];
    const picker = createFolderPicker({ load: async folder => { requests.push(folder); return listing; }, onSelect: folder => selected.push(folder) });
    await picker.open();
    expect(requests).toEqual([undefined]);
    expect(selected).toEqual([]);
    picker.select();
    expect(selected).toEqual([listing.currentPath]);
    expect(picker.state.open).toBe(false);
    picker.select();
    expect(selected).toEqual([listing.currentPath]);
  });

  it('passes exact folder-name bytes to the project inspection callback', async () => {
    const selected = [];
    const exact = '/Users/developer/code/repo ';
    const picker = createFolderPicker({ load: async () => ({ ...listing, currentPath: exact }), onSelect: folder => selected.push(folder) });
    await picker.open(exact);
    picker.select();
    expect(selected).toEqual([exact]);
  });

  it('ignores stale directory replies and a pending reply after closing', async () => {
    const responses = [];
    const picker = createFolderPicker({ load: () => new Promise(resolve => responses.push(resolve)), onSelect: () => {} });
    const old = picker.open('/old');
    const current = picker.navigate('/new');
    responses[1]({ ...listing, currentPath: '/new' });
    await current;
    responses[0]({ ...listing, currentPath: '/old' });
    await old;
    expect(picker.state.listing.currentPath).toBe('/new');
    const pending = picker.navigate('/last');
    picker.close();
    responses[2]({ ...listing, currentPath: '/last' });
    await pending;
    expect(picker.state.open).toBe(false);
    expect(picker.state.listing.currentPath).toBe('/new');
  });

  it('escapes filesystem names and reports unreadable locations without inventing folders', async () => {
    const html = renderFolderPicker({ listing: { ...listing, folders: [{ name: '<img onerror=alert(1)>', path: '/repo/"bad', isGitRepository: false }] }, loading: false, query: '', error: null });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    const picker = createFolderPicker({ load: async () => { throw new Error('Access denied'); }, onSelect: () => { throw new Error('Must not select'); } });
    await picker.open();
    expect(picker.state).toMatchObject({ loading: false, listing: null, error: { message: 'Access denied' } });
    picker.select();
  });
});
