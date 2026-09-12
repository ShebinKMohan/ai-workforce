import { esc } from '../render.js';
import { controlCenterDefaults } from '../control-center-settings.js';
import { runtimeReport } from '../runtime-settings.js';
import { departmentLabel } from '../model.js';
import { toolName } from '../words.js';
import { errorHtml } from './common.js';

export function renderControlCenterPanel({ ws, ui }) {
  const draft = ui.controlCenterDraft || controlCenterDefaults(ws.config);
  const binding = ws.config?.runtimes?.[draft.runtime];
  const report = binding ? runtimeReport(ws.reports, draft.runtime, binding) : null;
  const automatic = !draft.runtime;
  const options = Object.entries(ws.config?.runtimes || {}).filter(([id, runtime]) => ['codex', 'claude-code'].includes(runtime.adapter) || id === draft.runtime).map(([id, runtime]) => `<option value="${esc(id)}"${id === draft.runtime ? ' selected' : ''}>${esc(toolName(runtime.adapter))} · ${esc(id)}</option>`).join('');
  const status = automatic ? 'Automatic runtime selection' : !report ? 'Runtime not checked' : !report.installed ? 'Executable missing' : report.auth === 'logged_out' ? 'Runtime sign-in required' : 'Runtime configured';
  const fieldsDisabled = automatic || !ws.ok ? ' disabled' : '';
  const routeRows = ws.liveProjects.map((project) => {
    const saved = draft.routes?.[project.id] || '';
    const departments = ws.departments.filter((department) => !department.archived || department.id === saved).map((department) => `<option value="${esc(department.id)}"${saved === department.id ? ' selected' : ''}>${esc(departmentLabel(ws, department.id))}${department.archived ? ' (archived)' : ''}</option>`).join('');
    return `<div class="field"><label for="control-route-${esc(project.id)}">${esc(project.name)}</label><select id="control-route-${esc(project.id)}" data-bind="control-center-route" data-project="${esc(project.id)}"${fieldsDisabled}><option value=""${saved ? '' : ' selected'}>Let Control Center decide</option>${departments}</select></div>`;
  }).join('');
  return `<div class="section-head"><h2 id="control-center-title">Control Center</h2><span class="runtime-state">${esc(status)}</span></div><p class="muted">The role you talk to. It interprets the request and chooses the team; that team's head plans and supervises execution.</p>
    <div class="field"><label for="control-center-runtime">Routing runtime</label><select id="control-center-runtime" data-bind="control-center" data-field="runtime"${ws.ok ? '' : ' disabled'}><option value=""${automatic ? ' selected' : ''}>Automatic · available configured runtime</option>${options}</select><span class="hint">${automatic ? 'Uses a supported available runtime when a request arrives. Choose a binding to customize the routing role.' : `${esc(toolName(binding?.adapter))} · ${esc(binding?.executable || '')}. Each request records the runtime and settings it used.`}</span></div>
    <div class="editor-grid"><div class="field"><label for="control-center-model">Model override</label><input type="text" id="control-center-model" data-bind="control-center" data-field="model" value="${esc(draft.model)}" maxlength="128" placeholder="${esc(binding?.model || 'Inherit runtime default')}" spellcheck="false"${fieldsDisabled}></div><div class="field"><label for="control-center-effort">Reasoning effort override</label><input type="text" id="control-center-effort" data-bind="control-center" data-field="effort" value="${esc(draft.effort)}" maxlength="32" placeholder="${esc(binding?.effort || 'Inherit runtime default')}" spellcheck="false"${fieldsDisabled}></div></div><p class="muted small">Blank overrides inherit the binding's defaults. Enter only model and effort values supported by the installed CLI; they are validated before routing.</p>
    <div class="field"><label for="control-center-instructions">Routing instructions (optional)</label><textarea id="control-center-instructions" rows="3" data-bind="control-center" data-field="instructions" maxlength="12000" placeholder="Describe how requests should be interpreted and when a team needs clarification."${fieldsDisabled}>${esc(draft.instructions)}</textarea><span class="hint">These guide intake and team selection. Department and worker instructions stay separate.</span></div>
    <details class="runtime-diagnostics" data-state-key="control-center-routes"${ui.expanded?.has('control-center-routes') ? ' open' : ''}><summary>Project specialization</summary><p class="muted small">An explicit rule routes every request for that project to the chosen team. Projects without a rule use model classification, including when only one team is eligible.</p>${routeRows ? `<div class="editor-grid">${routeRows}</div>` : '<p class="muted small">Add a project to configure a specialization rule.</p>'}</details>
    ${automatic && ws.config?.controlCenter ? '<p class="tone-attention small">Saving Automatic removes this role’s custom overrides and project specialization rules.</p>' : ''}${ui.actionError?.key === 'control-center' ? errorHtml(ui.actionError.error) : ''}${ui.notice?.key === 'control-center' ? `<p role="status">${esc(ui.notice.text)}</p>` : ''}<div class="button-row"><button type="button" class="button button-primary" data-action="save-control-center"${ws.ok ? '' : ' disabled'}>Save Control Center</button><span class="muted small">Applies to new requests. Saved tasks retain their recorded settings.</span></div>`;
}
