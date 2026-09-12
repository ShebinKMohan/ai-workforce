/**
 * The facts readiness needs that only disk and Git can supply: how many
 * acceptance checks each project resolves at its last commit, and what passive
 * discovery found about the coding tools. The readiness rules themselves are
 * pure and live in `core/workspace-config.ts`.
 *
 * Nothing here starts a model turn or writes anything: the checks are read
 * from the committed base exactly as a run reads them, and the tools come from
 * reports the caller already has.
 */
import { existsSync, statSync } from 'node:fs';
import { resolveAcceptanceChecks } from '../core/run-direct.js';
import { workspaceReadiness, type ToolFact, type WorkspaceConfig, type WorkspaceProject, type WorkspaceReadiness } from '../core/workspace-config.js';
import { inspectProject } from '../workspaces/project.js';

export interface ProjectCheckFact {
  readonly projectId: string;
  /** Resolved check count; null when it could not be determined. */
  readonly count: number | null;
  /** `cli_flags` (the project's configured checks), `repository_config`, `detected`, `none`, or null when unknown. */
  readonly source: string | null;
  readonly detail: string;
}

export async function resolveProjectChecks(project: WorkspaceProject): Promise<ProjectCheckFact> {
  const unknown = (detail: string): ProjectCheckFact => ({ projectId: project.id, count: null, source: null, detail });
  if (!existsSync(project.repoPath) || !statSync(project.repoPath).isDirectory()) return unknown(`the folder ${project.repoPath} does not exist`);
  try {
    const inspection = await inspectProject(project.repoPath);
    if (!inspection.isGitRepo || inspection.repositoryRoot === null) return unknown(`${project.repoPath} is not a Git repository`);
    if (inspection.headRevision === null) return unknown(`${inspection.repositoryRoot} has no commit yet, so there is no base to read checks from`);
    const resolved = await resolveAcceptanceChecks(inspection.repositoryRoot, inspection.headRevision, project.checks);
    return { projectId: project.id, count: resolved.checks.length, source: resolved.source, detail: resolved.detail };
  } catch (error) {
    return unknown((error as Error).message);
  }
}

/** Map passive discovery reports to the structural facts readiness reads. */
export function toolFacts(reports: ReadonlyArray<{ adapter: string; installed: boolean; adapterSupported: boolean; auth: string }>): ToolFact[] {
  return reports.map((report) => ({ adapter: report.adapter, installed: report.installed, adapterSupported: report.adapterSupported, auth: report.auth }));
}

export interface ComputedReadiness {
  readonly readiness: WorkspaceReadiness;
  readonly checks: ReadonlyArray<ProjectCheckFact>;
}

export async function computeWorkspaceReadiness(config: WorkspaceConfig, input: { readonly tools?: ReadonlyArray<ToolFact> } = {}): Promise<ComputedReadiness> {
  const checks = await Promise.all(config.projects.map((project) => resolveProjectChecks(project)));
  const projectCheckCounts = Object.fromEntries(checks.map((fact) => [fact.projectId, fact.count]));
  return {
    readiness: workspaceReadiness(config, { projectCheckCounts, ...(input.tools !== undefined ? { tools: input.tools } : {}) }),
    checks,
  };
}
