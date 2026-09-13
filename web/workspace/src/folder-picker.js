import { postJson } from './api.js';
import { esc } from './render.js';

const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/></svg>';

export function folderBreadcrumbs(folder) {
  const parts = String(folder || '/').split('/').filter(Boolean);
  return [{ name: 'Computer', path: '/' }, ...parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }))];
}

export function renderFolderPicker(state, id = 'folder-picker') {
  const listing = state.listing;
  const filtered = (listing?.folders || []).filter(folder => folder.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
  const disabled = state.loading ? ' disabled' : '';
  return `<section class="folder-picker" aria-labelledby="${id}-title"><div class="fp-heading"><div><h3 id="${id}-title">Choose a project folder</h3><p>Browse folders on this computer. Files stay on your machine.</p></div><button type="button" class="fp-close" data-folder-action="close" aria-label="Close folder browser">×</button></div>
    ${listing?.places.length ? `<nav class="fp-places" aria-label="Folder locations">${listing.places.map(place => `<button type="button" data-folder-action="open" data-folder-path="${esc(place.path)}"${disabled}>${esc(place.label)}</button>`).join('')}</nav>` : ''}
    <div class="fp-toolbar"><button type="button" data-folder-action="open" data-folder-path="${esc(listing?.parentPath || '')}" aria-label="Parent folder"${!listing?.parentPath || state.loading ? ' disabled' : ''}>↑</button><nav class="fp-breadcrumbs" aria-label="Current folder">${folderBreadcrumbs(listing?.currentPath || '/').map(part => `<button type="button" data-folder-action="open" data-folder-path="${esc(part.path)}"${disabled}>${esc(part.name)}</button>`).join('')}</nav></div>
    ${listing ? `<div class="fp-search"><label class="fp-sr-only" for="${id}-search">Filter folders in this location</label><input id="${id}-search" type="search" data-folder-query placeholder="Filter folders in this location" value="${esc(state.query)}"${disabled}></div>` : ''}
    ${state.error ? `<p class="fp-error" role="alert">${esc(state.error.message || state.error)}</p>` : ''}
    <div class="fp-list" aria-busy="${state.loading}">${state.loading ? '<p class="fp-empty" role="status">Reading folders…</p>' : filtered.length ? filtered.map(folder => `<button type="button" class="fp-folder" data-folder-action="open" data-folder-path="${esc(folder.path)}" aria-label="Open ${esc(folder.name)}">${folderIcon}<span>${esc(folder.name)}</span>${folder.isGitRepository ? '<small>Git</small>' : ''}<b aria-hidden="true">›</b></button>`).join('') : `<p class="fp-empty">${state.query ? 'No folders match this filter.' : listing ? 'No visible subfolders. You can select the current folder.' : 'Open a folder location to continue.'}</p>`}</div>
    ${listing?.truncated ? '<p class="fp-note">This location contains more entries than the browser can list. Open a narrower folder or use Enter a path.</p>' : ''}
    <div class="fp-selection"><div>${folderIcon}<span><strong>${esc(listing?.currentPath.split('/').filter(Boolean).at(-1) || 'Computer')}</strong><small>${esc(listing?.currentPath || 'Choose a folder')}${listing?.isGitRepository ? ' · Git folder' : ''}</small></span></div><button type="button" class="fp-select" data-folder-action="select"${!listing || state.loading ? ' disabled' : ''}>Use this folder</button></div><p class="fp-note">The next step checks Git, the committed revision, and project verification commands.</p></section>`;
}

/** One shallow, authenticated directory read at a time. Closing invalidates pending navigation. */
export function createFolderPicker({ onSelect, load = (folder) => postJson('/api/projects/folders', folder ? { path: folder } : {}), id = 'folder-picker' }) {
  const state = { open: false, loading: false, listing: null, error: null, query: '' };
  let host = null;
  let sequence = 0;
  let opener = null;
  function paint() {
    if (!host) return;
    host.hidden = !state.open;
    if (!state.open) { host.innerHTML = ''; return; }
    const searchFocused = host.contains(document.activeElement) && document.activeElement?.hasAttribute('data-folder-query');
    const selection = searchFocused ? document.activeElement.selectionStart : null;
    host.innerHTML = renderFolderPicker(state, id);
    host.querySelectorAll('[data-folder-action]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.folderAction === 'close') close();
      else if (button.dataset.folderAction === 'select') select();
      else void navigate(button.dataset.folderPath);
    }));
    host.querySelector('[data-folder-query]')?.addEventListener('input', event => { state.query = event.target.value; paint(); });
    host.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    if (searchFocused) { const input = host.querySelector('[data-folder-query]'); input?.focus({ preventScroll: true }); if (selection !== null) input?.setSelectionRange(selection, selection); }
  }
  async function navigate(folder) {
    const attempt = ++sequence;
    state.loading = true;
    state.error = null;
    state.query = '';
    paint();
    try {
      const listing = await load(folder || undefined);
      if (!state.open || sequence !== attempt) return;
      state.listing = listing;
    } catch (error) { if (!state.open || sequence !== attempt) return; state.error = error; }
    state.loading = false;
    paint();
    host?.querySelector('[data-folder-query]')?.focus({ preventScroll: true });
  }
  function close() { state.open = false; state.loading = false; sequence += 1; paint(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  function select() { if (!state.open || !state.listing || state.loading) return; const folder = state.listing.currentPath; close(); onSelect(folder); }
  return {
    state,
    mount(element) { host = element; paint(); },
    open(folder) { opener = typeof document === 'undefined' ? null : document.activeElement; state.open = true; state.listing = null; return navigate(folder); },
    navigate,
    close,
    select,
  };
}
