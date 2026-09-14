import { describe, expect, it } from 'vitest';
import { validateWorkspace, type WorkspaceConfig } from '../../src/core/workspace-config.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { buildNathanJamesTeamOps } from '../../src/workspace/team-templates.js';
import { build, refusal } from './helpers.js';

const ORIGINAL_IDS = ['mike-slattery', 'russ-jeter', 'kara-foster', 'alisha-granderson', 'danny-green', 'andrea-garnett', 'sasha-cooper', 'rachel-scott', 'eric-miller'];
const NEW_IDS = ['tex-nolan', 'ravit-bivas', 'will-mason', 'carlton-burk', 'cameron-burk', 'kathleen-nolan'];
const NAMES = ['Mike Slattery', 'Russ Jeter', 'Kara Foster', 'Alisha Granderson', 'Danny Green', 'Andrea Garnett', 'Sasha Cooper', 'Rachel Scott', 'Eric Miller'];
const OLD_ROUTE = 'For an actionable software request, route to Mike Slattery, head of Nathan James Engineering (department id: nathan-james-engineering), using the actual catalog and available routing tools.';

function originalTeam(): WorkspaceConfig {
  return build([
    { op: 'runtime.set', id: 'codex-installed', adapter: 'codex', executable: '/configured/account-a/codex', model: 'runtime-model', effort: 'high' },
    { op: 'runtime.set', id: 'claude-installed', adapter: 'claude-code', executable: '/configured/account-b/claude' },
    { op: 'project.add', id: 'project-one', repoPath: '/projects/one' },
    { op: 'department.add', id: 'nathan-james-engineering', name: 'Nathan James Engineering', color: 'slate' },
    { op: 'control-center.set', runtime: 'codex-installed', model: 'control-model', effort: 'high', avatarId: 'portrait-16', instructions: `${OLD_ROUTE}\nChandler owns intent; Slattery owns planning, assignment, integration, and review; named specialists execute.\nKeep all confidential notes private.`, projectRoutes: [{ projectId: 'project-one', departmentId: 'nathan-james-engineering' }] },
    ...ORIGINAL_IDS.map((id, index) => ({ op: 'agent.add', id, name: NAMES[index], role: index === 0 ? 'head' : 'worker', departmentId: 'nathan-james-engineering',
      runtime: id === 'russ-jeter' ? 'claude-installed' : 'codex-installed', model: id === 'russ-jeter' ? 'opus[1m]' : 'gpt-6-astra', effort: id === 'russ-jeter' ? 'max' : 'medium',
      policy: ['mike-slattery', 'russ-jeter', 'sasha-cooper'].includes(id) ? 'analysis' : id === 'rachel-scott' ? 'verification' : 'local-development',
      instructions: `ROLE: ${id === 'russ-jeter' ? 'Principal Engineer / Architecture & Review' : 'Existing Specialty'}\nYou are ${NAMES[index]}, reporting to Mike Slattery.\n\nSPECIALIST RESPONSIBILITIES\nPreserve my custom workflow for ${id}.\nGive Slattery the result. Send proposed fixes to Slattery.\nYou belong to Nathan James Engineering, a software team.`,
      capabilities: [`custom-${index}`], avatarId: 'portrait-03', ...(index === 0 ? {} : { projectIds: ['project-one'], projectScope: 'restricted' }),
    })),
  ]);
}

function apply(config: WorkspaceConfig) {
  const proposal = buildNathanJamesTeamOps(config);
  return { proposal, after: applyWorkspaceOps(config, proposal.ops) };
}

describe('Nathan James organization template', () => {
  it('proposes five real departments and preserves nine identities while adding six specialists', () => {
    const before = originalTeam();
    const frozen = structuredClone(before);
    const { proposal, after } = apply(before);
    expect(before).toEqual(frozen);
    expect(proposal).toMatchObject({ planVersion: 1, templateId: 'nathan-james-technical', expectRevision: before.revision });
    expect(proposal.summary.addedAgentIds).toEqual(NEW_IDS);
    expect(proposal.summary.addedDepartmentIds).toHaveLength(4);
    expect(proposal.summary.promotedAgentIds).toEqual(['kara-foster', 'alisha-granderson', 'andrea-garnett', 'rachel-scott']);
    expect(after.departments.map(department => department.name)).toEqual(['Architecture & Delivery', 'Frontend & Design', 'Backend & Data', 'Platform & Security', 'Quality Engineering']);
    expect(after.departments.find(department => department.id === 'nathan-james-engineering')).toMatchObject({ color: 'slate', headAgentId: 'mike-slattery' });
    expect(after.agents).toHaveLength(15);
    expect(after.agents.filter(agent => agent.role === 'head')).toHaveLength(5);
    expect(after.agents.filter(agent => agent.role === 'worker')).toHaveLength(10);
    expect(after.retiredIds).toEqual(before.retiredIds);
    expect(validateWorkspace(after).ok).toBe(true);
    expect(parseWorkspaceOps(proposal.ops)).toEqual(proposal.ops);
  });

  it('preserves existing model, runtime, account path, effort, portrait, skills, and explicit worker restrictions', () => {
    const before = originalTeam();
    const { after } = apply(before);
    expect(after.runtimes).toEqual(before.runtimes);
    expect(after.projects).toEqual(before.projects);
    expect(after.limits).toEqual(before.limits);
    for (const previous of before.agents) {
      const current = after.agents.find(agent => agent.id === previous.id)!;
      expect(current).toMatchObject({ name: previous.name, runtime: previous.runtime, model: previous.model, effort: previous.effort, avatarId: previous.avatarId });
      expect(current.capabilities).toEqual(expect.arrayContaining(previous.capabilities));
      expect(current.instructions).toContain(`Preserve my custom workflow for ${previous.id}.`);
      if (current.role === 'worker') expect(current).toMatchObject({ policy: previous.policy, projectIds: previous.projectIds, projectScope: previous.projectScope });
      else expect(current).toMatchObject({ policy: 'analysis', projectIds: [] });
    }
    expect(after.controlCenter).toMatchObject({ ...before.controlCenter!, instructions: expect.any(String) });
    const russ = after.agents.find(agent => agent.id === 'russ-jeter')!;
    expect(russ).toMatchObject({ runtime: 'claude-installed', model: 'opus[1m]', effort: 'max', jobTitle: 'Principal Engineer / Architecture & Review' });
    for (const id of NEW_IDS) {
      const current = after.agents.find(agent => agent.id === id)!;
      expect(current).toMatchObject({ runtime: 'codex-installed', model: 'gpt-6-astra', effort: 'medium', projectIds: [], projectScope: 'all' });
    }
  });

  it('keeps chosen job titles and names through promotion, moves, and repeated setup', () => {
    const before = build([{ op: 'agent.edit', id: 'kara-foster', name: 'Kara', jobTitle: 'Experience Director' }, { op: 'agent.edit', id: 'russ-jeter', jobTitle: 'Principal Architect' }], originalTeam());
    const { after } = apply(before);
    expect(after.agents.find(agent => agent.id === 'kara-foster')).toMatchObject({ name: 'Kara', role: 'head', jobTitle: 'Experience Director' });
    expect(after.agents.find(agent => agent.id === 'will-mason')!.instructions).toContain('reporting to Kara (kara-foster)');
    expect(after.agents.find(agent => agent.id === 'russ-jeter')!.jobTitle).toBe('Principal Architect');
    expect(buildNathanJamesTeamOps(after).ops).toEqual([]);
  });

  it('accepts editor-trimmed and legacy trailing separators without proposing configuration changes', () => {
    const { after } = apply(originalTeam());
    for (const newline of ['\n', '\r\n']) {
      for (const suffix of ['', newline, `${newline}${newline}`]) {
        const will = after.agents.find(agent => agent.id === 'will-mason')!;
        const edited = build([{ op: 'agent.edit', id: will.id, jobTitle: 'Frontend Developer', instructions: `${will.instructions.trim().replace(/\r?\n/g, newline)}${suffix}` }], after);
        const frozen = structuredClone(edited);
        expect(buildNathanJamesTeamOps(edited).ops).toEqual([]);
        expect(edited).toEqual(frozen);
      }
    }
  });

  it('retains custom instructions after a complete closing marker, including a single newline separator', () => {
    const { after } = apply(originalTeam());
    const will = after.agents.find(agent => agent.id === 'will-mason')!;
    const custom = 'CUSTOM WORKFLOW\nPreserve the customer schema.\nKeep this literal marker example: [END WORKFORCE TEAM TEMPLATE].';
    const edited = build([{ op: 'agent.edit', id: will.id, instructions: `${will.instructions.trim()}\n${custom}` }], after);
    const proposal = buildNathanJamesTeamOps(edited);
    const updated = applyWorkspaceOps(edited, proposal.ops).agents.find(agent => agent.id === will.id)!;
    expect(updated.instructions.endsWith(custom)).toBe(true);
    expect(updated.instructions.match(/\[WORKFORCE TEAM TEMPLATE:/g)).toHaveLength(1);
    expect(updated).toMatchObject({ runtime: will.runtime, model: will.model, effort: will.effort, avatarId: will.avatarId, policy: will.policy });
    expect(buildNathanJamesTeamOps(applyWorkspaceOps(edited, proposal.ops)).ops).toEqual([]);
  });

  it('still refuses a missing or inline closing marker without mutating any custom instructions', () => {
    const { after } = apply(originalTeam());
    const will = after.agents.find(agent => agent.id === 'will-mason')!;
    for (const ending of ['CUSTOM NOTE without a closing marker', 'inline [END WORKFORCE TEAM TEMPLATE]\nCUSTOM NOTE']) {
      const instructions = `${will.instructions.slice(0, will.instructions.indexOf('\n[END WORKFORCE TEAM TEMPLATE]'))}\n${ending}`;
      const edited = build([{ op: 'agent.edit', id: will.id, instructions }], after);
      const frozen = structuredClone(edited);
      expect(refusal(() => buildNathanJamesTeamOps(edited)).code).toBe('invalid_template_block');
      expect(edited).toEqual(frozen);
    }
  });

  it('replaces obsolete reporting and hard routing without losing unrelated custom instructions', () => {
    const before = build([{ op: 'agent.edit', id: 'danny-green', instructions: `${originalTeam().agents.find(agent => agent.id === 'danny-green')!.instructions}\nNever send secrets to Mike Slattery. Preserve fixtures from Mike Slattery.` }], originalTeam());
    const { after } = apply(before);
    const danny = after.agents.find(agent => agent.id === 'danny-green')!;
    expect(danny.instructions).toContain('reporting to Alisha Granderson (alisha-granderson)');
    expect(danny.instructions).toContain('Give Alisha Granderson the result. Send proposed fixes to Alisha Granderson.');
    expect(danny.instructions).not.toContain('Give Slattery');
    expect(danny.instructions).toContain('Never send secrets to Mike Slattery. Preserve fixtures from Mike Slattery.');
    expect(danny.instructions).not.toContain('ROLE: Existing Specialty');
    expect(after.controlCenter!.instructions).not.toContain(OLD_ROUTE);
    expect(after.controlCenter!.instructions).not.toContain('Slattery owns');
    expect(after.controlCenter!.instructions).toContain('Keep all confidential notes private.');
    expect(after.controlCenter!.instructions).toContain('Frontend & Design (nathan-james-frontend-design)');
    expect(after.agents.find(agent => agent.id === 'kara-foster')!.instructions).toContain('SPECIALIST KNOWLEDGE FOR PLANNING AND REVIEW');
    expect(buildNathanJamesTeamOps(after).ops).toEqual([]);
    const amended = build([{ op: 'agent.edit', id: 'danny-green', instructions: `${danny.instructions}\nPreserve this later custom note.` }], after);
    expect(buildNathanJamesTeamOps(amended).ops).toEqual([]);
  });

  it('starts a fresh team with a configured runtime and creates no installation or account configuration', () => {
    const before = build([{ op: 'runtime.set', id: 'chosen-runtime', adapter: 'codex', executable: '/chosen/account/codex' }]);
    const proposal = buildNathanJamesTeamOps(before, { defaultRuntimeId: 'chosen-runtime' });
    const after = applyWorkspaceOps(before, proposal.ops);
    expect(after.agents).toHaveLength(15);
    expect(after.agents.every(agent => agent.runtime === 'chosen-runtime')).toBe(true);
    expect(after.runtimes).toEqual(before.runtimes);
    expect(after.controlCenter).toBeUndefined();
    expect(buildNathanJamesTeamOps(after).ops).toEqual([]);
  });

  it('keeps custom constraints inside Mike\'s mission and roster sections when removing obsolete team statements', () => {
    const before = build([{ op: 'agent.edit', id: 'mike-slattery', instructions: [
      'ROLE: ENGINEERING DEPARTMENT HEAD',
      'DEPARTMENT MISSION',
      "Design, build, debug, integrate, and verify useful software. Cover application architecture, accessible frontend behavior, APIs and data, full stack integration, local platform reliability, security, QA, and test automation. Success is the user's requested behavior demonstrably working in the authorized environment.",
      'Custom mission constraint: preserve customer integration contracts.',
      '', 'PLANNING AND DELEGATION', 'Custom planning constraint: retain existing release ownership.',
      '', 'ROSTER AND SPECIALIZATION',
      'Kara Foster: frontend and UI engineering; accessible, responsive, truthful interactions.',
      'Custom roster constraint: use independent review for migrations.',
      '', 'DELIVERY AND REVIEW', 'Custom delivery constraint: publish only after authorization.',
    ].join('\n') }], originalTeam());
    const { after } = apply(before);
    const instructions = after.agents.find(agent => agent.id === 'mike-slattery')!.instructions;
    expect(instructions).toContain('Custom mission constraint: preserve customer integration contracts.');
    expect(instructions).toContain('Custom planning constraint: retain existing release ownership.');
    expect(instructions).toContain('Custom roster constraint: use independent review for migrations.');
    expect(instructions).toContain('Custom delivery constraint: publish only after authorization.');
    expect(instructions).not.toContain('Kara Foster: frontend and UI engineering;');
    expect(instructions).not.toContain('Cover application architecture, accessible frontend behavior, APIs and data');
    expect(buildNathanJamesTeamOps(after).ops).toEqual([]);
  });

  it('reports signed-out runtime readiness without silently changing the configured provider', () => {
    const before = originalTeam();
    const proposal = buildNathanJamesTeamOps(before, { runtimeReports: [{ runtimeId: 'claude-installed', usable: false, auth: 'logged_out' }, { runtimeId: 'codex-installed', usable: true, auth: 'logged_in' }] });
    expect(proposal.warnings).toEqual([expect.stringContaining("Russ Jeter's configured runtime (claude-installed) is signed out")]);
    const russ = applyWorkspaceOps(before, proposal.ops).agents.find(agent => agent.id === 'russ-jeter')!;
    expect(russ).toMatchObject({ runtime: 'claude-installed', model: 'opus[1m]', effort: 'max' });
  });

  it('refuses archived identities, retired IDs, and another existing department head without modifying input', () => {
    const archived = build([{ op: 'agent.archive', id: 'kara-foster' }], originalTeam());
    expect(refusal(() => buildNathanJamesTeamOps(archived)).code).toBe('template_agent_archived');
    expect(archived.agents.find(agent => agent.id === 'kara-foster')!.archived).toBe(true);
    const retired = originalTeam();
    retired.retiredIds.agents.push('ravit-bivas');
    expect(refusal(() => buildNathanJamesTeamOps(retired)).code).toBe('id_retired');
    const collision = build([
      { op: 'department.add', id: 'nathan-james-frontend-design', name: 'Other frontend group' },
      { op: 'agent.add', id: 'other-head', role: 'head', departmentId: 'nathan-james-frontend-design', runtime: 'codex-installed' },
    ], originalTeam());
    expect(refusal(() => buildNathanJamesTeamOps(collision)).code).toBe('template_head_conflict');
    expect(collision.departments.find(department => department.id === 'nathan-james-frontend-design')!.headAgentId).toBe('other-head');
  });

  it('preserves unrelated departments and agents while reconciling only template members', () => {
    const before = build([
      { op: 'department.add', id: 'research', name: 'Research' },
      { op: 'agent.add', id: 'research-head', role: 'head', departmentId: 'research', runtime: 'claude-installed' },
    ], originalTeam());
    const { after } = apply(before);
    expect(after.departments.find(department => department.id === 'research')).toEqual(before.departments.find(department => department.id === 'research'));
    expect(after.agents.find(agent => agent.id === 'research-head')).toEqual(before.agents.find(agent => agent.id === 'research-head'));
  });
});
