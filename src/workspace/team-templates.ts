/** Reviewable, repeatable team setup. This module never reads or writes live state. */
import { agentJobTitle, validateWorkspace, type AgentAvatarId, type AgentRole, type DepartmentColor, type WorkspaceAgent, type WorkspaceConfig } from '../core/workspace-config.js';
import { canonicalJson } from '../core/snapshot.js';
import { invalidWorkspaceInput } from './errors.js';
import { applyWorkspaceOp, parseWorkspaceOps, type WorkspaceOp } from './operations.js';

export const NATHAN_JAMES_TEMPLATE_ID = 'nathan-james-technical' as const;
const BLOCK_START = '[WORKFORCE TEAM TEMPLATE: nathan-james-technical v1]';
const BLOCK_END = '[END WORKFORCE TEAM TEMPLATE]';
const LEGACY_ENGINEERING_MISSION = "Design, build, debug, integrate, and verify useful software. Cover application architecture, accessible frontend behavior, APIs and data, full stack integration, local platform reliability, security, QA, and test automation. Success is the user's requested behavior demonstrably working in the authorized environment.";
const LEGACY_MOVED_ROSTER_LINES = new Set([
  'Kara Foster: frontend and UI engineering; accessible, responsive, truthful interactions.',
  'Alisha Granderson: backend and API engineering; business rules, data, validation, and concurrency.',
  'Danny Green: full stack implementation and cross-component integration.',
  'Andrea Garnett: platform and developer experience; local startup, tooling, builds, and runtime diagnosis.',
  'Sasha Cooper: security analysis and threat review (analysis policy); hand remediation to an eligible developer.',
  'Rachel Scott: independent QA and acceptance verification (verification policy); hand source changes to a developer.',
  'Eric Miller: test automation and regression tooling implementation.',
]);

interface DepartmentTemplate {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly color: DepartmentColor;
  readonly headAgentId: string;
}
interface AgentTemplate {
  readonly id: string;
  readonly name: string;
  readonly jobTitle: string;
  readonly departmentId: string;
  readonly role: AgentRole;
  readonly policy: WorkspaceAgent['policy'];
  readonly capabilities: readonly string[];
  readonly responsibility: string;
  readonly avatarId?: AgentAvatarId;
}

export const NATHAN_JAMES_DEPARTMENTS: readonly DepartmentTemplate[] = [
  { id: 'nathan-james-engineering', name: 'Architecture & Delivery', note: 'Architecture, technical planning, integration, and delivery.', color: 'blue', headAgentId: 'mike-slattery' },
  { id: 'nathan-james-frontend-design', name: 'Frontend & Design', note: 'Product design, accessible interfaces, and browser behavior.', color: 'rose', headAgentId: 'kara-foster' },
  { id: 'nathan-james-backend-data', name: 'Backend & Data', note: 'APIs, business rules, databases, and data integrity.', color: 'sand', headAgentId: 'alisha-granderson' },
  { id: 'nathan-james-platform-security', name: 'Platform & Security', note: 'Runtime reliability, developer tooling, and security.', color: 'lavender', headAgentId: 'andrea-garnett' },
  { id: 'nathan-james-quality-engineering', name: 'Quality Engineering', note: 'Acceptance, regression automation, and independent checks.', color: 'sage', headAgentId: 'rachel-scott' },
];

export const NATHAN_JAMES_AGENTS: readonly AgentTemplate[] = [
  { id: 'mike-slattery', name: 'Mike Slattery', jobTitle: 'Architecture & Delivery Head', departmentId: 'nathan-james-engineering', role: 'head', policy: 'analysis', capabilities: ['planning', 'architecture', 'delivery', 'delegation', 'review'], responsibility: 'Own architecture decisions, technical delivery planning, integration contracts, and cross-department dependencies. Select the smallest sufficient team from the actual admitted roster.' },
  { id: 'russ-jeter', name: 'Russ Jeter', jobTitle: 'Principal Engineer / Architecture & Review', departmentId: 'nathan-james-engineering', role: 'worker', policy: 'analysis', capabilities: ['architecture', 'technical-review', 'reliability', 'api-contracts', 'analysis'], responsibility: 'Inspect architecture, system boundaries, contracts, and reliability. Return concrete source evidence and actionable review findings; delegate implementation through the head.' },
  { id: 'tex-nolan', name: 'Tex Nolan', jobTitle: 'Systems & Delivery Engineer', departmentId: 'nathan-james-engineering', role: 'worker', policy: 'local-development', avatarId: 'portrait-15', capabilities: ['architecture', 'integration', 'delivery', 'systems', 'coding'], responsibility: 'Implement bounded systems and integration work, resolve cross-component delivery defects, and verify complete working paths. Coordinate shared contracts and file ownership with the relevant specialists and preserve independent review.' },
  { id: 'kara-foster', name: 'Kara Foster', jobTitle: 'Frontend & Design Head', departmentId: 'nathan-james-frontend-design', role: 'head', policy: 'analysis', capabilities: ['planning', 'frontend', 'ui', 'accessibility', 'design', 'review'], responsibility: 'Plan and review product design, accessible frontend behavior, interaction details, and browser acceptance. Assign implementation and design work to the appropriate available specialist.' },
  { id: 'ravit-bivas', name: 'Ravit Bivas', jobTitle: 'Product Designer', departmentId: 'nathan-james-frontend-design', role: 'worker', policy: 'local-development', avatarId: 'portrait-10', capabilities: ['product-design', 'interaction-design', 'ui', 'accessibility', 'prototyping'], responsibility: 'Turn the requested outcome into clear user flows, useful information hierarchy, accessible interactions, and reviewable design artifacts. Work within existing design patterns and validate the affected user experience.' },
  { id: 'will-mason', name: 'Will Mason', jobTitle: 'Frontend Engineer', departmentId: 'nathan-james-frontend-design', role: 'worker', policy: 'local-development', avatarId: 'portrait-11', capabilities: ['frontend', 'ui', 'accessibility', 'responsive-design', 'browser-testing', 'coding'], responsibility: 'Implement complete frontend behavior, including loading, empty, success, and failure states. Preserve accessibility and responsive behavior, and verify the affected browser flow.' },
  { id: 'alisha-granderson', name: 'Alisha Granderson', jobTitle: 'Backend & Data Head', departmentId: 'nathan-james-backend-data', role: 'head', policy: 'analysis', capabilities: ['planning', 'backend', 'api', 'persistence', 'data', 'review'], responsibility: 'Plan and review API contracts, business rules, data models, persistence, and concurrency. Define observable backend acceptance and assign bounded implementation to eligible workers.' },
  { id: 'danny-green', name: 'Danny Green', jobTitle: 'Full Stack & Integration Engineer', departmentId: 'nathan-james-backend-data', role: 'worker', policy: 'local-development', capabilities: ['full-stack', 'backend', 'integration', 'debugging', 'end-to-end', 'coding'], responsibility: 'Deliver complete features across application boundaries. Trace input through validation, APIs, persistence, and the visible result, and verify the affected integration path.' },
  { id: 'carlton-burk', name: 'Carlton Burk', jobTitle: 'Database Engineer', departmentId: 'nathan-james-backend-data', role: 'worker', policy: 'local-development', avatarId: 'portrait-12', capabilities: ['database', 'data-modeling', 'persistence', 'migrations', 'query-performance', 'coding'], responsibility: 'Implement data models, queries, and authorized migrations with durable invariants, compatibility, and meaningful rollback or recovery planning. Preserve stored data and verify real persistence behavior.' },
  { id: 'andrea-garnett', name: 'Andrea Garnett', jobTitle: 'Platform & Security Head', departmentId: 'nathan-james-platform-security', role: 'head', policy: 'analysis', capabilities: ['planning', 'platform', 'security', 'local-runtime', 'developer-tooling', 'review'], responsibility: 'Plan and review local runtime reliability, setup automation, developer tooling, and security boundaries. Delegate implementation and independent security review with explicit environment ownership.' },
  { id: 'sasha-cooper', name: 'Sasha Cooper', jobTitle: 'Security Engineer / Reviewer', departmentId: 'nathan-james-platform-security', role: 'worker', policy: 'analysis', capabilities: ['security-review', 'threat-modeling', 'authorization', 'input-validation', 'analysis'], responsibility: 'Review reachable trust boundaries, authorization, injection risks, and secret handling. Ground findings in concrete evidence and authorized nondestructive checks. Keep analysis read-only and send remediation to an eligible developer.' },
  { id: 'cameron-burk', name: 'Cameron Burk', jobTitle: 'Runtime & Developer Tooling Engineer', departmentId: 'nathan-james-platform-security', role: 'worker', policy: 'local-development', avatarId: 'portrait-13', capabilities: ['platform', 'local-runtime', 'developer-tooling', 'setup-automation', 'builds', 'coding'], responsibility: 'Make local installation, startup, runtime connections, and recovery automatic and observable. Identify owned processes and environments before changes, preserve unrelated services, and verify the affected service and application entry point.' },
  { id: 'rachel-scott', name: 'Rachel Scott', jobTitle: 'Quality Engineering Head', departmentId: 'nathan-james-quality-engineering', role: 'head', policy: 'analysis', capabilities: ['planning', 'qa', 'verification', 'acceptance-testing', 'regression-analysis', 'review'], responsibility: 'Define observable acceptance and review independent evidence. Assign realistic workflow verification and regression automation separately as needed. Never waive a failed requirement or substitute simulated evidence for the affected system.' },
  { id: 'eric-miller', name: 'Eric Miller', jobTitle: 'Test Automation & Regression Engineer', departmentId: 'nathan-james-quality-engineering', role: 'worker', policy: 'local-development', capabilities: ['test-automation', 'regression-testing', 'integration-tests', 'fixtures', 'coding'], responsibility: 'Implement maintainable regression coverage and test tooling that fails for the underlying defect. Use realistic fixtures and deterministic cleanup, and distinguish automated coverage from browser and live-service proof.' },
  { id: 'kathleen-nolan', name: 'Kathleen Nolan', jobTitle: 'QA & Acceptance Engineer', departmentId: 'nathan-james-quality-engineering', role: 'worker', policy: 'verification', avatarId: 'portrait-14', capabilities: ['qa', 'verification', 'acceptance-testing', 'browser-testing', 'reproduction'], responsibility: 'Independently exercise realistic success, failure, and boundary cases against the identified candidate and environment. Record reproducible defects and actual results without changing implementation or weakening checks.' },
];

export interface TeamTemplateRuntimeReport {
  readonly runtimeId?: string | null;
  readonly usable?: boolean;
  readonly auth?: string;
}
export interface NathanJamesTemplateOptions {
  /** Only used when adding identities that have no existing head/runtime to inherit. */
  readonly defaultRuntimeId?: string;
  /** Optional passive discovery results; warnings never change an agent binding. */
  readonly runtimeReports?: readonly TeamTemplateRuntimeReport[];
}
export interface TeamTemplatePlan {
  readonly planVersion: 1;
  readonly templateId: typeof NATHAN_JAMES_TEMPLATE_ID;
  readonly expectRevision: number;
  readonly ops: readonly WorkspaceOp[];
  readonly summary: {
    readonly departments: readonly { readonly id: string; readonly name: string; readonly headAgentId: string; readonly workerIds: readonly string[] }[];
    readonly addedDepartmentIds: readonly string[];
    readonly addedAgentIds: readonly string[];
    readonly promotedAgentIds: readonly string[];
    readonly updatedAgentIds: readonly string[];
    readonly controlCenterUpdated: boolean;
  };
  readonly warnings: readonly string[];
}

function unwrapped(instructions: string): string {
  const prefix = instructions.startsWith(`${BLOCK_START}\r\n`) ? `${BLOCK_START}\r\n` : `${BLOCK_START}\n`;
  if (!instructions.startsWith(prefix)) return instructions;
  const body = instructions.slice(prefix.length);
  // Editors can trim the separator after the final marker. A complete marker
  // on its own line is sufficient; text after it remains user instructions.
  const end = /(?:^|\r?\n)\[END WORKFORCE TEAM TEMPLATE\](?=\r?\n|$)/.exec(body);
  if (!end) throw invalidWorkspaceInput('invalid_template_block', 'The saved team instructions have an incomplete template block.');
  return body.slice(end.index + end[0].length);
}
function wrapped(block: string, original: string): string {
  return `${BLOCK_START}\n${block}\n${BLOCK_END}${original ? `\n\n${original}` : ''}`;
}
const sameInstructions = (left: string, right: string): boolean => left.replace(/\r\n/g, '\n').trimEnd() === right.replace(/\r\n/g, '\n').trimEnd();
function reportingLines(original: string, recipient: string): string {
  return original
    .replace(/^\s*ROLE:[^\r\n]*(?:\r?\n|$)/i, '')
    .replace(/^You are [^\r\n]*, reporting to Mike Slattery\.\s*$/gm, '')
    .replace(/You belong to Nathan James Engineering,/g, 'You belong to the Nathan James technical organization,')
    .replace(/\b([Gg]ive) Slattery (?=the outcome,|a precise handoff|the result\.)/g, `$1 ${recipient} `)
    .replace(/\b([Ss]end proposed fixes) to Slattery\b/g, `$1 to ${recipient}`)
    .replace('Report exact results, reproducible defects, and untested limits to Slattery;', `Report exact results, reproducible defects, and untested limits to ${recipient};`)
    .trim();
}
function agentInstructions(spec: AgentTemplate, current: WorkspaceAgent | undefined, workspace: WorkspaceConfig): string {
  const department = NATHAN_JAMES_DEPARTMENTS.find(item => item.id === spec.departmentId)!;
  const name = current?.name ?? spec.name;
  const head = workspace.agents.find(agent => agent.id === department.headAgentId)?.name ?? NATHAN_JAMES_AGENTS.find(agent => agent.id === department.headAgentId)!.name;
  const recipient = spec.role === 'head' ? 'Tom Chandler through Control Center' : head;
  let retained = reportingLines(unwrapped(current?.instructions ?? ''), recipient);
  if (spec.id === 'mike-slattery') {
    retained = retained
      .replace(/head of Nathan James Engineering/g, 'head of Architecture & Delivery')
      .replace(LEGACY_ENGINEERING_MISSION, spec.responsibility)
      .split('\n').filter(line => !LEGACY_MOVED_ROSTER_LINES.has(line.trim())).join('\n');
  }
  if (spec.role === 'head') retained = retained.replace('SPECIALIST RESPONSIBILITIES', 'SPECIALIST KNOWLEDGE FOR PLANNING AND REVIEW');
  const workers = NATHAN_JAMES_AGENTS.filter(agent => agent.departmentId === spec.departmentId && agent.role === 'worker').map(agent => `${workspace.agents.find(existing => existing.id === agent.id)?.name ?? agent.name} (${agent.id})`).join(', ');
  const currentRole = spec.role === 'head'
    ? `You are ${name}, head of ${department.name}, reporting to ${recipient}. Your policy is analysis: inspect, plan, delegate, and review; assign all implementation and executable acceptance checks to eligible workers. Your department workers are ${workers}. Retained specialist knowledge below supports planning and review within this policy.`
    : `You are ${name}, a specialist in ${department.name}, reporting to ${recipient} (${department.headAgentId}). Follow the actual assignment's execution policy, scope, and evidence requirements.`;
  return wrapped([
    currentRole, spec.responsibility,
    'Use the actual admitted roster and workload. Workers are available across registered projects by default; preserve explicit project restrictions. Keep independent projects progressing within configured capacity and never invent assignments, progress, or results.',
    'Resolve routine reversible work autonomously within the request. Preserve dirty checkouts and concurrent work, use the harness tools, and report concrete evidence. Request input only when necessary information or authorization is missing. Never claim coordinator acceptance from your own completion message.',
    'Existing project, security, and working instructions below remain applicable. Current department roles and execution policy govern how their specialist expertise is used.',
  ].join('\n\n'), retained);
}
function controlInstructions(original: string): string {
  const retained = reportingLines(unwrapped(original)
    .replace('For an actionable software request, route to Mike Slattery, head of Nathan James Engineering (department id: nathan-james-engineering), using the actual catalog and available routing tools.', 'For actionable software work, route to the department whose current responsibilities match the request, using the actual catalog and routing tools.')
    .replace(/; Slattery owns planning, assignment, integration, and review;/g, '; the selected department head owns planning, assignment, integration, and review;')
    .replace("Pass the user's original intent, relevant attachments and context, authorized scope, environment boundary, and required proof to Slattery.", "Pass the user's original intent, relevant attachments and context, authorized scope, environment boundary, and required proof to the selected department head.")
    .replace('Do not invent messages from Slattery or a specialist.', 'Do not invent messages from a department head or a specialist.'), 'the selected department head');
  return wrapped([
    'Tom Chandler remains Control Center. Select the relevant department from the actual catalog by the request and required expertise, honoring explicit saved project routes. Architecture & Delivery is responsible for architecture and integration; it is not the default owner of every software request.',
    ...NATHAN_JAMES_DEPARTMENTS.map(department => `${department.name} (${department.id}): ${department.note} Head: ${department.headAgentId}.`),
    'Pass the original objective, constraints, attachments, and required evidence to the selected department head. Heads plan and review; admitted specialists execute bounded work. Keep multiple projects progressing within configured capacity, without manual per-project placement or routine approval requests.',
  ].join('\n\n'), retained);
}

/** Produce public operations with optimistic revision binding; callers decide when to apply them. */
export function buildNathanJamesTeamOps(config: WorkspaceConfig, options: NathanJamesTemplateOptions = {}): TeamTemplatePlan {
  const checked = validateWorkspace(config);
  if (!checked.ok) throw invalidWorkspaceInput('invalid_workspace', 'The organization must be valid before applying a team template.', checked.issues.map(issue => `${issue.path}: ${issue.message}`));
  if (options.defaultRuntimeId !== undefined && !(options.defaultRuntimeId in config.runtimes)) throw invalidWorkspaceInput('unknown_runtime', `The selected runtime "${options.defaultRuntimeId}" is not configured.`);
  let draft = checked.config;
  const ops: WorkspaceOp[] = [];
  const addedDepartmentIds: string[] = [];
  const addedAgentIds: string[] = [];
  const promotedAgentIds: string[] = [];
  const updatedAgentIds: string[] = [];
  const warnings: string[] = [];
  const append = (raw: Record<string, unknown>): void => {
    const op = parseWorkspaceOps([raw])[0]!;
    draft = applyWorkspaceOp(draft, op);
    ops.push(op);
  };

  for (const department of NATHAN_JAMES_DEPARTMENTS) {
    const current = draft.departments.find(item => item.id === department.id);
    if (current?.archived) throw invalidWorkspaceInput('template_department_archived', `The template department "${current.id}" is archived; its identity will not be reused.`);
    if (current?.headAgentId && current.headAgentId !== department.headAgentId) throw invalidWorkspaceInput('template_head_conflict', `Department "${department.id}" already has another head, "${current.headAgentId}".`);
    if (!current) {
      append({ op: 'department.add', id: department.id, name: department.name, note: department.note, color: department.color });
      addedDepartmentIds.push(department.id);
    } else if (current.name !== department.name || current.note !== department.note) append({ op: 'department.edit', id: department.id, name: department.name, note: department.note });
  }

  for (const spec of NATHAN_JAMES_AGENTS) {
    const current = draft.agents.find(agent => agent.id === spec.id);
    if (current?.archived) throw invalidWorkspaceInput('template_agent_archived', `Agent "${current.id}" is archived; this template cannot reactivate or replace that identity.`);
    if (current?.role === 'head' && spec.role !== 'head') throw invalidWorkspaceInput('template_role_conflict', `Agent "${current.id}" is already a head; the template will not demote an existing head.`);
    const legacyTitle = current ? agentJobTitle(current) : '';
    const jobTitle = current?.jobTitle ?? (spec.role === 'head' ? spec.jobTitle : !['Worker', 'Department Head', ''].includes(legacyTitle) ? legacyTitle : spec.jobTitle);
    const instructions = agentInstructions(spec, current, draft);
    if (current) {
      const patch: Record<string, unknown> = { op: 'agent.edit', id: current.id };
      if (current.departmentId !== spec.departmentId) patch['departmentId'] = spec.departmentId;
      if (current.role !== spec.role) { patch['role'] = spec.role; promotedAgentIds.push(current.id); }
      if (current.jobTitle !== jobTitle) patch['jobTitle'] = jobTitle;
      if (!sameInstructions(current.instructions, instructions)) patch['instructions'] = instructions;
      if (spec.role === 'head') {
        const capabilities = [...current.capabilities];
        for (const capability of ['planning', 'delegation', 'review']) if (!capabilities.includes(capability) && capabilities.length < 32) capabilities.push(capability);
        if (canonicalJson(capabilities) !== canonicalJson(current.capabilities)) patch['capabilities'] = capabilities;
      }
      if (Object.keys(patch).length > 2) { append(patch); updatedAgentIds.push(current.id); }
    } else {
      const department = NATHAN_JAMES_DEPARTMENTS.find(item => item.id === spec.departmentId)!;
      const donor = config.agents.find(agent => agent.id === department.headAgentId && !agent.archived)
        ?? draft.agents.find(agent => agent.id === 'mike-slattery' && !agent.archived);
      const ids = Object.keys(config.runtimes);
      const runtime = donor?.runtime ?? options.defaultRuntimeId ?? config.controlCenter?.runtime ?? (ids.length === 1 ? ids[0] : undefined);
      if (!runtime) throw invalidWorkspaceInput('template_runtime_required', 'Choose one configured runtime for the new team members. Existing agent bindings will be preserved.');
      append({ op: 'agent.add', id: spec.id, name: spec.name, jobTitle, role: spec.role, departmentId: spec.departmentId,
        runtime, ...(donor?.model !== undefined ? { model: donor.model } : {}), ...(donor?.effort !== undefined ? { effort: donor.effort } : {}),
        ...(spec.avatarId ? { avatarId: spec.avatarId } : {}), instructions, capabilities: [...new Set([...spec.capabilities, ...(spec.role === 'head' ? ['planning', 'delegation', 'review'] : [])])], policy: spec.policy, projectIds: [], projectScope: 'all' });
      addedAgentIds.push(spec.id);
    }
  }

  let controlCenterUpdated = false;
  if (config.controlCenter) {
    const instructions = controlInstructions(config.controlCenter.instructions ?? '');
    if (!sameInstructions(instructions, config.controlCenter.instructions ?? '')) {
      append({ op: 'control-center.set', ...config.controlCenter, instructions });
      controlCenterUpdated = true;
    }
  }
  for (const spec of NATHAN_JAMES_AGENTS) {
    const agent = draft.agents.find(item => item.id === spec.id)!;
    const report = options.runtimeReports?.find(item => item.runtimeId === agent.runtime);
    if (report?.auth === 'logged_out') warnings.push(`${agent.name}'s configured runtime (${agent.runtime}) is signed out. Its runtime, model, and effort were preserved; connect that account before assigning work.`);
    else if (report?.usable === false) warnings.push(`${agent.name}'s configured runtime (${agent.runtime}) is currently unavailable. Its saved binding was preserved.`);
  }
  for (const department of NATHAN_JAMES_DEPARTMENTS) {
    const workers = draft.agents.filter(agent => !agent.archived && agent.role === 'worker' && agent.departmentId === department.id);
    if (workers.length && workers.every(agent => {
      const report = options.runtimeReports?.find(item => item.runtimeId === agent.runtime);
      return report?.usable === false || report?.auth === 'logged_out';
    })) warnings.push(`${department.name} has no worker with a usable configured runtime. Connect an existing worker's account before dispatching this department's work.`);
  }
  const final = validateWorkspace(draft);
  if (!final.ok) throw invalidWorkspaceInput('invalid_template_result', 'The proposed team operations would create an invalid organization.', final.issues.map(issue => `${issue.path}: ${issue.message}`));
  return { planVersion: 1, templateId: NATHAN_JAMES_TEMPLATE_ID, expectRevision: config.revision, ops,
    summary: { departments: NATHAN_JAMES_DEPARTMENTS.map(department => ({ id: department.id, name: department.name, headAgentId: department.headAgentId, workerIds: NATHAN_JAMES_AGENTS.filter(agent => agent.departmentId === department.id && agent.role === 'worker').map(agent => agent.id) })), addedDepartmentIds, addedAgentIds, promotedAgentIds, updatedAgentIds, controlCenterUpdated }, warnings };
}
