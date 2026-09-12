/**
 * The Add a project sheet: paste a folder path, look at it with Git only,
 * see the checks the verifier would find, name it, and add it. A project with
 * no check can be added, but setup step 2 stays open until it has one.
 */
import { esc } from '../render.js';
import { plural } from '../words.js';
import { errorHtml } from '../pages/common.js';

export function addProjectDefaults() {
  return { name: 'add-project', path: '', inspecting: false, inspection: null, projectName: '', checks: [''], saving: false, error: null };
}

/** The inspection, in the page's words. */
export function inspectionLines(inspection) {
  if (!inspection) return [];
  const lines = [];
  if (!inspection.exists) return [{ tone: 'failed', text: 'This folder does not exist on this computer.' }];
  if (!inspection.isDirectory) return [{ tone: 'failed', text: 'This is a file, not a folder.' }];
  if (!inspection.isGitRepo) return [{ tone: 'failed', text: 'This folder is not a Git repository. A project is a Git repository with at least one commit.' }];
  if (inspection.existingProjectId) lines.push({ tone: 'failed', text: 'This repository is already in the workspace.' });
  if (inspection.overlapsStateRoot) lines.push({ tone: 'failed', text: "This folder overlaps Workforce's own files. Choose a project folder." });
  if (!inspection.headRevision) lines.push({ tone: 'failed', text: 'This repository has no commits yet. Make a first commit so workers have a starting point.' });
  else {
    const dirty = inspection.dirty ?? {};
    const count = (dirty.staged ?? 0) + (dirty.unstaged ?? 0) + (dirty.untracked ?? 0) + (dirty.conflicted ?? 0);
    const where = inspection.detachedHead ? 'a detached commit' : inspection.branch ?? 'its current branch';
    lines.push({ tone: 'neutral', text: `Git repository · ${where} · ${count === 0 ? 'no uncommitted changes' : `${plural(count, 'file')} with uncommitted changes. Tasks start from your last commit; your changes stay where they are.`}` });
  }
  if (inspection.repositoryRoot && inspection.path && inspection.repositoryRoot !== inspection.path) lines.push({ tone: 'neutral', text: `The project will be the whole repository at ${inspection.repositoryRoot}.` });
  return lines;
}

export function renderAddProjectSheet(ctx, sheet) {
  const inspection = sheet.inspection;
  const lines = inspectionLines(inspection);
  const found = inspection?.checks?.count ?? 0;
  const typed = sheet.checks.map((check) => check.trim()).filter(Boolean);
  const checksBlock = inspection?.canAdd
    ? found > 0
      ? `<div class="field"><span class="label">Checks the verifier will run</span><p>Found ${plural(found, 'check')} in the project at your last commit:</p><ul>${inspection.checks.criteria.map((criterion) => `<li><code>${esc([criterion.command, ...(criterion.args ?? [])].join(' '))}</code></li>`).join('')}</ul></div>`
      : `<fieldset><legend>Checks the verifier will run</legend><p class="muted small">${inspection.checks?.error ? `The project's checks file could not be read: ${esc(inspection.checks.error.message)}` : 'No checks found. Add at least one command the verifier runs, such as npm test. It passes when the command exits successfully.'}</p>
        ${sheet.checks.map((check, index) => `<div class="inline-field" style="margin-bottom:6px"><input type="text" id="project-check-${index}" aria-label="Check ${index + 1}" data-bind="sheet:checks.${index}" data-rerender value="${esc(check)}" placeholder="npm test">${sheet.checks.length > 1 ? `<button type="button" class="link-button" data-action="remove-check-row" data-index="${index}">Remove</button>` : ''}</div>`).join('')}
        <button type="button" class="link-button" data-action="add-check-row">+ Add another</button></fieldset>`
    : '';
  const canAdd = Boolean(inspection?.canAdd) && sheet.projectName.trim().length > 0 && !sheet.saving;
  const addLabel = sheet.saving ? 'Adding…' : found > 0 || typed.length > 0 ? 'Add project' : 'Add without checks';
  const body = `<div class="field"><label for="project-path">Folder</label><span class="hint">Paste a Git repository path on this computer. You can start with ~/ for your home folder.</span>
      <div class="inline-field"><input type="text" id="project-path" data-bind="sheet:path" value="${esc(sheet.path)}" placeholder="/Users/you/code/my-app" autocomplete="off" spellcheck="false"><button type="button" class="button" data-action="inspect-folder" ${sheet.inspecting ? 'disabled' : ''}>${sheet.inspecting ? 'Looking…' : 'Check folder'}</button></div>
      </div>
    ${lines.length ? `<ul class="step-lines">${lines.map((line) => `<li class="tone-${line.tone}">${esc(line.text)}</li>`).join('')}</ul><p class="muted small">Looked at with Git only; nothing was changed.</p>` : ''}
    ${inspection?.canAdd ? `<div class="field"><label for="project-name">Name</label><input type="text" id="project-name" data-bind="sheet:projectName" data-rerender value="${esc(sheet.projectName)}" maxlength="80"></div>` : ''}
    ${checksBlock}
    ${sheet.error ? errorHtml(sheet.error) : ''}
    <p class="muted small">Removing a project later never deletes its folder.</p>`;
  return `<div class="sheet-head"><h2 id="sheet-title">Add a project</h2><button type="button" class="button button-small" data-action="close-sheet">Close</button></div>
    <div class="sheet-body">${body}</div>
    <div class="sheet-foot"><button type="button" class="button" data-action="close-sheet">Cancel</button><button type="button" class="button button-primary" data-action="add-project" ${canAdd ? '' : 'disabled'}>${addLabel}</button></div>`;
}
