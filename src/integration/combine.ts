/**
 * Serialized integration of approved artifacts into one combined candidate
 * (FR045) and the acceptance rule for that combination (AT13).
 *
 * Two things this module refuses to do:
 *
 *  1. It never guesses at a merge. Artifacts are ordered deterministically and
 *     applied in that order; changes that do not overlap are combined, and
 *     anything else — a different contract version, a different base, the same
 *     file changed by two artifacts in overlapping hunks, a binary file two
 *     artifacts both rewrote — is refused with a named, focused conflict that
 *     says which artifacts and which file are in tension.
 *
 *  2. It never lets a check that passed on an individual branch stand in for
 *     the combination. Acceptance of the combined candidate is computed only
 *     from receipts whose recorded candidate revision *is* the combined
 *     revision. Branch receipts are carried through as context and are
 *     explicitly labelled as not establishing anything.
 *
 * Only one owner combines at a time: `IntegrationGate` serializes combinations
 * per repository so two coordinators cannot build a combined candidate from
 * overlapping inputs concurrently.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { nowIso, randomToken } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { COORDINATOR_IDENTITY, git, gitOrThrow, gitText, resolveRevision } from '../workspaces/git.js';
import { EVIDENCE_PROVENANCE, runChecks as defaultRunChecks, type CheckReceipt, type CheckSpec, type FixtureMutation, type RunChecksInput } from '../verification/checks.js';
import { findSurfaceChanges, resolveAcceptanceSurface, surfaceBlockers } from '../verification/surface.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ApprovedArtifact {
  readonly artifactId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Task contract version this artifact was produced against. */
  readonly contractVersion: number;
  /** Commit the artifact's patch applies to. */
  readonly baseRevision: string;
  /** Path to the binary-safe patch produced by `snapshotCandidate`. */
  readonly patchPath: string;
  /** sha256 of the patch bytes; verified before the patch is used. */
  readonly patchHash: string;
  /**
   * Receipts from checks run on this artifact's own branch. Carried for
   * context only: they never establish the combined candidate.
   */
  readonly branchReceipts?: ReadonlyArray<CheckReceipt>;
}

export type CheckRunner = (input: RunChecksInput) => Promise<CheckReceipt[]>;

export interface CombineInput {
  readonly runId: string;
  readonly projectRoot: string;
  /** The commit every artifact must be based on. */
  readonly baseRevision: string;
  readonly artifacts: ReadonlyArray<ApprovedArtifact>;
  /** Coordinator-owned directory (outside the repository) for the integration worktree. */
  readonly integrationRoot: string;
  readonly integrationId?: string;
  /** Checks to re-run against the combined revision. */
  readonly checks: ReadonlyArray<CheckSpec>;
  readonly checkOutputRoot: string;
  readonly runChecks?: CheckRunner;
  readonly gate?: IntegrationGate;
  readonly keepWorkspace?: boolean;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export type FileChangeKind = 'added' | 'deleted' | 'modified' | 'renamed';

export interface PatchFile {
  /** Post-image path (the pre-image path for a deletion). */
  readonly path: string;
  readonly oldPath: string | null;
  readonly change: FileChangeKind;
  readonly binary: boolean;
  readonly hunks: ReadonlyArray<PatchHunk>;
}

function stripPrefix(value: string): string {
  let out = value.trim();
  if (out.startsWith('"') && out.endsWith('"') && out.length > 1) out = out.slice(1, -1);
  if (out === '/dev/null') return out;
  if (out.startsWith('a/') || out.startsWith('b/')) return out.slice(2);
  return out;
}

/** Parse a `git diff` (including `--binary`) into per-file change records. */
export function parseUnifiedDiff(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = text.split('\n');
  let headerPath: string | null = null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let change: FileChangeKind = 'modified';
  let binary = false;
  let hunks: PatchHunk[] = [];
  let open = false;

  const flush = (): void => {
    if (!open) return;
    const post = newPath !== null && newPath !== '/dev/null' ? newPath : null;
    const pre = oldPath !== null && oldPath !== '/dev/null' ? oldPath : null;
    const resolved = post ?? pre ?? headerPath;
    if (resolved !== null) {
      files.push({
        path: resolved,
        oldPath: pre !== null && pre !== resolved ? pre : null,
        change,
        binary,
        hunks,
      });
    }
    open = false;
    headerPath = null;
    oldPath = null;
    newPath = null;
    change = 'modified';
    binary = false;
    hunks = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      open = true;
      const rest = line.slice('diff --git '.length);
      const split = rest.lastIndexOf(' b/');
      headerPath = split === -1 ? stripPrefix(rest) : stripPrefix(rest.slice(split + 1));
      continue;
    }
    if (!open) continue;
    if (line.startsWith('new file mode')) change = 'added';
    else if (line.startsWith('deleted file mode')) change = 'deleted';
    else if (line.startsWith('rename from ')) {
      change = 'renamed';
      oldPath = stripPrefix(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      change = 'renamed';
      newPath = stripPrefix(line.slice('rename to '.length));
    } else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) binary = true;
    else if (line.startsWith('--- ')) oldPath = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) newPath = stripPrefix(line.slice(4));
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match !== null) {
        hunks.push({
          oldStart: Number(match[1]),
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newLines: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    }
  }
  flush();
  return files;
}

/** Inclusive pre-image line range a hunk covers, including its context lines. */
export function hunkOldRange(hunk: PatchHunk): { readonly start: number; readonly end: number } {
  if (hunk.oldLines === 0) return { start: hunk.oldStart, end: hunk.oldStart };
  return { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 };
}

// ---------------------------------------------------------------------------
// Conflicts and planning
// ---------------------------------------------------------------------------

export type IntegrationConflictKind =
  | 'contract_version_mismatch'
  | 'base_revision_mismatch'
  | 'duplicate_artifact'
  | 'patch_unreadable'
  | 'patch_hash_mismatch'
  | 'overlapping_hunks'
  | 'file_mode_conflict'
  | 'binary_overlap'
  | 'apply_failed'
  | 'no_artifacts';

export interface IntegrationConflict {
  readonly kind: IntegrationConflictKind;
  /** Stable, focused name: `<kind>` or `<kind>:<file>`. */
  readonly name: string;
  readonly file: string | null;
  /** Artifact ids in tension, in the deterministic order. */
  readonly artifacts: ReadonlyArray<string>;
  readonly detail: string;
}

export interface CombinationPlan {
  /** Artifact ids in the exact order patches are applied. */
  readonly order: ReadonlyArray<string>;
  /** Files each artifact touches, keyed by artifact id. */
  readonly touchedFiles: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Files two or more artifacts touch without conflicting. */
  readonly sharedFiles: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<IntegrationConflict>;
}

/** Deterministic application order: task id, then attempt id, then artifact id. */
export function integrationOrder(artifacts: ReadonlyArray<ApprovedArtifact>): ApprovedArtifact[] {
  return [...artifacts].sort((a, b) => {
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    if (a.attemptId !== b.attemptId) return a.attemptId < b.attemptId ? -1 : 1;
    return a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0;
  });
}

export interface PlanOptions {
  readonly baseRevision: string;
  /** Reads a patch file. Injectable so planning is testable without a filesystem. */
  readonly readPatch?: (artifact: ApprovedArtifact) => string;
}

/**
 * Decide whether these artifacts can be combined at all, without touching Git.
 * Pure with respect to the repository: it reads patches and compares them.
 */
export function planCombination(artifacts: ReadonlyArray<ApprovedArtifact>, options: PlanOptions): CombinationPlan {
  const readPatch = options.readPatch ?? ((artifact: ApprovedArtifact) => readFileSync(artifact.patchPath, 'utf8'));
  const ordered = integrationOrder(artifacts);
  const order = ordered.map((artifact) => artifact.artifactId);
  const conflicts: IntegrationConflict[] = [];

  if (ordered.length === 0) {
    return {
      order,
      touchedFiles: new Map(),
      sharedFiles: [],
      conflicts: [{ kind: 'no_artifacts', name: 'no_artifacts', file: null, artifacts: [], detail: 'no approved artifacts were supplied, so there is nothing to combine' }],
    };
  }

  const seen = new Set<string>();
  for (const artifact of ordered) {
    if (seen.has(artifact.artifactId)) {
      conflicts.push({
        kind: 'duplicate_artifact',
        name: `duplicate_artifact:${artifact.artifactId}`,
        file: null,
        artifacts: [artifact.artifactId],
        detail: `artifact "${artifact.artifactId}" appears more than once in the approved set`,
      });
    }
    seen.add(artifact.artifactId);
  }

  const contractVersions = [...new Set(ordered.map((artifact) => artifact.contractVersion))].sort((a, b) => a - b);
  if (contractVersions.length > 1) {
    conflicts.push({
      kind: 'contract_version_mismatch',
      name: 'contract_version_mismatch',
      file: null,
      artifacts: order,
      detail:
        `the approved artifacts were produced against different task contract versions (${contractVersions.join(', ')}): ` +
        ordered.map((artifact) => `${artifact.artifactId}=v${artifact.contractVersion}`).join(', ') +
        '; combining them would mean combining work that answered different questions',
    });
  }

  for (const artifact of ordered) {
    if (artifact.baseRevision !== options.baseRevision) {
      conflicts.push({
        kind: 'base_revision_mismatch',
        name: `base_revision_mismatch:${artifact.artifactId}`,
        file: null,
        artifacts: [artifact.artifactId],
        detail: `artifact "${artifact.artifactId}" is based on ${artifact.baseRevision} but the integration base is ${options.baseRevision}; a patch against a different base cannot be applied here without guessing`,
      });
    }
  }

  const parsed = new Map<string, ReadonlyArray<PatchFile>>();
  const touchedFiles = new Map<string, ReadonlyArray<string>>();
  for (const artifact of ordered) {
    let text: string;
    try {
      text = readPatch(artifact);
    } catch (error) {
      conflicts.push({
        kind: 'patch_unreadable',
        name: `patch_unreadable:${artifact.artifactId}`,
        file: null,
        artifacts: [artifact.artifactId],
        detail: `could not read the patch for artifact "${artifact.artifactId}" at ${artifact.patchPath}: ${(error as Error).message}`,
      });
      continue;
    }
    const actualHash = sha256Hex(Buffer.from(text, 'utf8'));
    if (artifact.patchHash === '') {
      // An artifact with no recorded hash cannot be checked against the file
      // on disk, so combining it would mean trusting whatever is there now.
      conflicts.push({
        kind: 'patch_hash_mismatch',
        name: `patch_hash_missing:${artifact.artifactId}`,
        file: null,
        artifacts: [artifact.artifactId],
        detail: `artifact "${artifact.artifactId}" recorded no patch hash, so the content at ${artifact.patchPath} cannot be verified as the approved content`,
      });
      continue;
    }
    if (actualHash !== artifact.patchHash) {
      conflicts.push({
        kind: 'patch_hash_mismatch',
        name: `patch_hash_mismatch:${artifact.artifactId}`,
        file: null,
        artifacts: [artifact.artifactId],
        detail: `the patch at ${artifact.patchPath} hashes to ${actualHash} but artifact "${artifact.artifactId}" recorded ${artifact.patchHash}; the approved content is not the content on disk`,
      });
      continue;
    }
    const files = parseUnifiedDiff(text);
    parsed.set(artifact.artifactId, files);
    touchedFiles.set(artifact.artifactId, files.map((file) => file.path).sort());
  }

  // Pairwise, per file, in the deterministic order.
  const sharedFiles = new Set<string>();
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = ordered[i]!;
      const right = ordered[j]!;
      const leftFiles = parsed.get(left.artifactId);
      const rightFiles = parsed.get(right.artifactId);
      if (leftFiles === undefined || rightFiles === undefined) continue;
      for (const leftFile of leftFiles) {
        const rightFile = rightFiles.find((candidate) => candidate.path === leftFile.path || candidate.oldPath === leftFile.path || candidate.path === leftFile.oldPath);
        if (rightFile === undefined) continue;
        const pair = [left.artifactId, right.artifactId];
        if (leftFile.binary || rightFile.binary) {
          conflicts.push({
            kind: 'binary_overlap',
            name: `binary_overlap:${leftFile.path}`,
            file: leftFile.path,
            artifacts: pair,
            detail: `"${left.artifactId}" and "${right.artifactId}" both change the binary file ${leftFile.path}; binary content has no hunks to compare, so the combination cannot be shown to be non-overlapping`,
          });
          continue;
        }
        if (leftFile.change !== 'modified' || rightFile.change !== 'modified') {
          conflicts.push({
            kind: 'file_mode_conflict',
            name: `file_mode_conflict:${leftFile.path}`,
            file: leftFile.path,
            artifacts: pair,
            detail: `"${left.artifactId}" ${leftFile.change} ${leftFile.path} and "${right.artifactId}" ${rightFile.change} it; the two changes are about the file's existence, not lines within it`,
          });
          continue;
        }
        const overlapping: string[] = [];
        for (const leftHunk of leftFile.hunks) {
          const a = hunkOldRange(leftHunk);
          for (const rightHunk of rightFile.hunks) {
            const b = hunkOldRange(rightHunk);
            if (a.start <= b.end && b.start <= a.end) overlapping.push(`${left.artifactId}@${a.start}-${a.end} vs ${right.artifactId}@${b.start}-${b.end}`);
          }
        }
        if (overlapping.length > 0) {
          conflicts.push({
            kind: 'overlapping_hunks',
            name: `overlapping_hunks:${leftFile.path}`,
            file: leftFile.path,
            artifacts: pair,
            detail: `"${left.artifactId}" and "${right.artifactId}" change overlapping regions of ${leftFile.path} (pre-image lines, context included): ${overlapping.join('; ')}; resolving this needs a decision about intent, not a merge`,
          });
        } else {
          sharedFiles.add(leftFile.path);
        }
      }
    }
  }

  return { order, touchedFiles, sharedFiles: [...sharedFiles].sort(), conflicts };
}

// ---------------------------------------------------------------------------
// Acceptance of the combined candidate (AT13)
// ---------------------------------------------------------------------------

export interface CriterionVerdict {
  readonly criterionId: string;
  readonly required: boolean;
  readonly satisfied: boolean;
  /** Receipt id from the combined revision, or null when nothing was run there. */
  readonly receiptId: string | null;
  readonly outcome: string | null;
  readonly reason: string;
}

export interface CombinedAcceptance {
  readonly accepted: boolean;
  readonly combinedRevision: string;
  readonly verdicts: ReadonlyArray<CriterionVerdict>;
  /** Criteria with no receipt bound to the combined revision. */
  readonly unverifiedCriteria: ReadonlyArray<string>;
  /** Receipts discarded because they belong to some other revision. */
  readonly ignoredReceiptIds: ReadonlyArray<string>;
  readonly reason: string;
}

export interface EvaluateCombinedInput {
  readonly combinedRevision: string;
  /** Criteria that must hold for the combination. */
  readonly requiredCriteria: ReadonlyArray<{ readonly id: string; readonly required?: boolean }>;
  /** Every receipt available, from any revision. Only combined-revision ones count. */
  readonly receipts: ReadonlyArray<CheckReceipt>;
  /**
   * Acceptance fixtures the combination modified or deleted. A criterion whose
   * own fixtures the combination rewrote cannot be established by a pass, for
   * the same reason it cannot on a single branch.
   */
  readonly fixtureMutations?: ReadonlyArray<FixtureMutation>;
  /** Reasons acceptance must be refused whatever the receipts say. */
  readonly blockers?: ReadonlyArray<string>;
}

/**
 * Decide whether the combined candidate is established.
 *
 * A receipt counts only when it records the combined revision as the candidate
 * it ran against. A receipt from an individual branch is discarded here by
 * construction — that is the whole point (AT13): "it passed on the branch" is
 * not evidence about the combination.
 */
export function evaluateCombinedAcceptance(input: EvaluateCombinedInput): CombinedAcceptance {
  // Two filters, not one. A receipt has to name the combined revision AND be
  // one the verifier produced: a receipt a worker handed in describes nothing
  // this coordinator executed, so it cannot establish anything (FR050).
  const atRevision = input.receipts.filter((receipt) => receipt.candidate.revision === input.combinedRevision);
  const applicable = atRevision.filter((receipt) => receipt.evidenceProvenance === EVIDENCE_PROVENANCE);
  const claimed = atRevision.filter((receipt) => receipt.evidenceProvenance !== EVIDENCE_PROVENANCE).map((receipt) => receipt.id);
  const ignored = [
    ...input.receipts.filter((receipt) => receipt.candidate.revision !== input.combinedRevision).map((receipt) => receipt.id),
    ...claimed,
  ];
  const mutations = input.fixtureMutations ?? [];
  const mutatedFor = (criterionId: string): ReadonlyArray<string> => {
    const paths = mutations.filter((entry) => entry.criterionId === criterionId || entry.criterionId === '*').flatMap((entry) => entry.changedPaths);
    return [...new Set(paths)].sort();
  };
  const verdicts: CriterionVerdict[] = [];
  const unverified: string[] = [];

  for (const criterion of input.requiredCriteria) {
    const required = criterion.required ?? true;
    const receipt = applicable.find((candidate) => candidate.criterionId === criterion.id) ?? null;
    if (receipt === null) {
      unverified.push(criterion.id);
      const claimedHere = atRevision.find((candidate) => candidate.criterionId === criterion.id && candidate.evidenceProvenance !== EVIDENCE_PROVENANCE) ?? null;
      const branchReceipt = claimedHere ?? input.receipts.find((candidate) => candidate.criterionId === criterion.id) ?? null;
      verdicts.push({
        criterionId: criterion.id,
        required,
        satisfied: false,
        receiptId: null,
        outcome: null,
        reason:
          branchReceipt === null
            ? `no check was executed against the combined revision ${input.combinedRevision} for "${criterion.id}"`
            : claimedHere !== null
              ? `"${criterion.id}" has a receipt naming the combined revision ${input.combinedRevision}, but its provenance is "${claimedHere.evidenceProvenance}" rather than "${EVIDENCE_PROVENANCE}"; a result the verifier did not execute establishes nothing`
              : `"${criterion.id}" has a receipt from ${branchReceipt.candidate.revision} (outcome "${branchReceipt.outcome}") but nothing was executed against the combined revision ${input.combinedRevision}; a pass on an individual branch does not establish the combination`,
      });
      continue;
    }
    const mutated = mutatedFor(criterion.id);
    const satisfied = receipt.outcome === 'passed' && mutated.length === 0;
    verdicts.push({
      criterionId: criterion.id,
      required,
      satisfied,
      receiptId: receipt.id,
      outcome: receipt.outcome,
      reason: satisfied
        ? `"${criterion.id}" passed against the combined revision ${input.combinedRevision}`
        : mutated.length > 0
          ? `"${criterion.id}" reported "${receipt.outcome}" against the combined revision ${input.combinedRevision}, but the combination changed the files it executes (${mutated.join(', ')}), so the result does not establish the criterion the base revision defined`
          : `"${criterion.id}" reported "${receipt.outcome}" against the combined revision ${input.combinedRevision}`,
    });
  }

  const failedRequired = verdicts.filter((verdict) => verdict.required && !verdict.satisfied);
  const blockers = input.blockers ?? [];
  const accepted = input.requiredCriteria.length > 0 && failedRequired.length === 0 && blockers.length === 0;
  const reason = accepted
    ? `every required criterion was executed against the combined revision ${input.combinedRevision} and passed`
    : input.requiredCriteria.length === 0
      ? 'no criteria were supplied, so the combined candidate establishes nothing'
      : `the combined candidate is not established: ${[...failedRequired.map((verdict) => verdict.reason), ...blockers].join('; ')}`;

  return { accepted, combinedRevision: input.combinedRevision, verdicts, unverifiedCriteria: unverified, ignoredReceiptIds: ignored, reason };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** One owner combines at a time, per key. Later callers queue behind the current one. */
export class IntegrationGate {
  readonly #chains = new Map<string, Promise<unknown>>();
  #activeKey: string | null = null;

  get active(): string | null {
    return this.#activeKey;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      this.#activeKey = key;
      try {
        return await fn();
      } finally {
        this.#activeKey = null;
      }
    });
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return await next;
  }
}

const defaultGate = new IntegrationGate();

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

export interface CombineRefused {
  readonly status: 'refused';
  readonly integrationId: string;
  readonly order: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<IntegrationConflict>;
  readonly summary: string;
}

export interface CombineSucceeded {
  readonly status: 'combined';
  readonly integrationId: string;
  readonly order: ReadonlyArray<string>;
  readonly plan: CombinationPlan;
  readonly branch: string;
  readonly workspacePath: string | null;
  readonly baseRevision: string;
  /** The exact revision every check below ran against. */
  readonly combinedRevision: string;
  readonly receipts: ReadonlyArray<CheckReceipt>;
  readonly acceptance: CombinedAcceptance;
  /** Branch receipts carried through as context; they establish nothing here. */
  readonly branchReceiptIds: ReadonlyArray<string>;
  /**
   * What resolving the acceptance surface from the base revision could not
   * settle. Empty means the import graph was followed to completion; a
   * non-empty entry means the fixture comparison above covered less than the
   * criteria actually execute, and `acceptance` refuses for exactly that
   * reason — a comparison that missed files cannot say the combination left
   * them alone.
   */
  readonly surfaceGaps: ReadonlyArray<string>;
  readonly combinedAt: string;
}

export type CombineResult = CombineRefused | CombineSucceeded;

export class IntegrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}

/**
 * Build the combined candidate from approved artifacts and re-run the checks
 * against the exact combined revision. Serialized per repository.
 */
export async function combineArtifacts(input: CombineInput): Promise<CombineResult> {
  const gate = input.gate ?? defaultGate;
  return await gate.run(path.resolve(input.projectRoot), async () => await combineOnce(input));
}

async function combineOnce(input: CombineInput): Promise<CombineResult> {
  const integrationId = input.integrationId ?? `int-${randomToken(6)}`;
  const projectRoot = realpathSync(input.projectRoot);
  const baseRevision = await resolveRevision(projectRoot, input.baseRevision);
  if (baseRevision === null) {
    throw new IntegrationError('unresolvable_base', `integration base "${input.baseRevision}" does not resolve to a commit in ${projectRoot}`);
  }

  const plan = planCombination(input.artifacts, { baseRevision });
  if (plan.conflicts.length > 0) {
    return {
      status: 'refused',
      integrationId,
      order: plan.order,
      conflicts: plan.conflicts,
      summary: `refused to combine ${input.artifacts.length} artifact(s): ${plan.conflicts.map((conflict) => conflict.name).join(', ')}`,
    };
  }

  const integrationRoot = path.resolve(input.integrationRoot);
  mkdirSync(integrationRoot, { recursive: true, mode: 0o700 });
  const workspacePath = path.join(integrationRoot, integrationId);
  if (existsSync(workspacePath)) {
    throw new IntegrationError('workspace_exists', `integration workspace ${workspacePath} already exists; refusing to reuse it`);
  }
  const branch = `workforce/integration/${input.runId}/${integrationId}`;

  await gitOrThrow(['worktree', 'add', '-b', branch, workspacePath, baseRevision], {
    cwd: projectRoot,
    noHooksDir: integrationRoot,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const ordered = integrationOrder(input.artifacts);
  const options = {
    cwd: workspacePath,
    noHooksDir: integrationRoot,
    identity: COORDINATOR_IDENTITY,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  } as const;

  try {
    for (const artifact of ordered) {
      const applied = await git(['apply', '--index', '--binary', '--whitespace=nowarn', artifact.patchPath], options);
      if (!applied.ok) {
        await disposeWorkspace(projectRoot, integrationRoot, workspacePath, branch);
        const file = firstRejectedFile(applied.stderr);
        return {
          status: 'refused',
          integrationId,
          order: plan.order,
          conflicts: [
            {
              kind: 'apply_failed',
              name: file === null ? 'apply_failed' : `apply_failed:${file}`,
              file,
              artifacts: [artifact.artifactId],
              detail: `applying artifact "${artifact.artifactId}" onto the combination failed: ${applied.stderr.trim().split('\n').slice(0, 4).join(' | ')}`,
            },
          ],
          summary: `refused to combine: artifact "${artifact.artifactId}" did not apply onto the combined tree`,
        };
      }
      await gitOrThrow(
        ['commit', '--no-verify', '--no-gpg-sign', '--allow-empty', '-m', `workforce integration: ${artifact.artifactId}\n\ntask: ${artifact.taskId}\nattempt: ${artifact.attemptId}\npatch: ${artifact.patchHash}\n`],
        options,
      );
    }

    const combinedRevision = await gitText(['rev-parse', 'HEAD'], { cwd: workspacePath });

    // Re-run the affected checks against the exact combined revision. Nothing
    // from an individual branch is reused here.
    const runner = input.runChecks ?? defaultRunChecks;
    const receipts = await runner({
      candidate: { repoRoot: workspacePath, revision: combinedRevision },
      checks: input.checks,
      outputRoot: path.join(input.checkOutputRoot, integrationId),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    // The same fixture rule the direct path applies, applied to the
    // combination: a combined candidate that rewrote the acceptance suite has
    // not passed the criteria the base defined, whatever the checks report.
    const surfaceFindings = await measureCombinedSurface(workspacePath, baseRevision, combinedRevision, input.checks);

    const branchReceipts = ordered.flatMap((artifact) => artifact.branchReceipts ?? []);
    const acceptance = evaluateCombinedAcceptance({
      combinedRevision,
      requiredCriteria: input.checks.map((check) => ({ id: check.criterionId, required: check.required ?? true })),
      receipts: [...branchReceipts, ...receipts],
      fixtureMutations: surfaceFindings.mutations,
      blockers: [
        ...(surfaceFindings.definitionChanges.length > 0
          ? [
              `the combination changed the acceptance definition (${surfaceFindings.definitionChanges.join(', ')}); this run read its criteria from the base revision, so the change cannot have been assessed here`,
            ]
          : []),
        ...surfaceFindings.blockers,
      ],
    });

    if (input.keepWorkspace !== true) await disposeWorkspace(projectRoot, integrationRoot, workspacePath, branch, false);

    return {
      status: 'combined',
      integrationId,
      order: plan.order,
      plan,
      branch,
      workspacePath: input.keepWorkspace === true ? workspacePath : null,
      baseRevision,
      combinedRevision,
      receipts,
      acceptance,
      branchReceiptIds: branchReceipts.map((receipt) => receipt.id),
      surfaceGaps: surfaceFindings.surfaceGaps,
      combinedAt: nowIso(),
    };
  } catch (error) {
    await disposeWorkspace(projectRoot, integrationRoot, workspacePath, branch);
    throw error;
  }
}

/** Remove the integration worktree. The branch is kept unless the combination never produced one. */
async function disposeWorkspace(projectRoot: string, integrationRoot: string, workspacePath: string, branch: string, deleteBranch = true): Promise<void> {
  await git(['worktree', 'remove', '--force', workspacePath], { cwd: projectRoot, noHooksDir: integrationRoot });
  rmSync(workspacePath, { recursive: true, force: true });
  await git(['worktree', 'prune'], { cwd: projectRoot });
  if (deleteBranch) await git(['branch', '-D', branch], { cwd: projectRoot });
}

function firstRejectedFile(stderr: string): string | null {
  const match = /error: patch failed: ([^:]+):/.exec(stderr) ?? /error: ([^:]+): patch does not apply/.exec(stderr);
  return match === null ? null : match[1]!.trim();
}

/**
 * What the combined tree changed, compared with the acceptance surface of the
 * base revision.
 *
 * Read from the integration worktree, which has both revisions: the surface
 * comes from the base tree (what the criteria meant when they were pinned) and
 * the changes from `base..combined`.
 *
 * The surface is resolved by following the import graph from each criterion's
 * entry points, exactly as the direct path does, so the combined decision
 * covers the same files. Resolving it any other way would leave the multi-task
 * path accepting a combination that gutted a helper the suite asserts through
 * while the single-task path refused it.
 *
 * And what it could not resolve blocks here too. Every failure below returns
 * a blocker rather than an empty surface: a combination measured against
 * nothing is not a combination that was measured, and "we could not read the
 * base tree" must never come out looking like "nothing was changed".
 */
async function measureCombinedSurface(
  workspacePath: string,
  baseRevision: string,
  combinedRevision: string,
  checks: ReadonlyArray<CheckSpec>,
): Promise<{
  mutations: ReadonlyArray<FixtureMutation>;
  definitionChanges: ReadonlyArray<string>;
  surfaceGaps: ReadonlyArray<string>;
  blockers: ReadonlyArray<string>;
}> {
  const unmeasured = (detail: string): { mutations: []; definitionChanges: []; surfaceGaps: string[]; blockers: string[] } => ({
    mutations: [],
    definitionChanges: [],
    surfaceGaps: [detail],
    blockers: [`the combined candidate's acceptance surface could not be measured at all: ${detail}. Without it a pass on the combination establishes nothing about the criteria the base revision defined`],
  });
  const listing = await git(['ls-tree', '-r', '--name-only', '-z', baseRevision], { cwd: workspacePath, maxOutputBytes: 8 * 1024 * 1024 });
  if (!listing.ok) return unmeasured(`the file list of base revision ${baseRevision} could not be read (${listing.stderr.trim().split('\n')[0] ?? 'git ls-tree failed'})`);
  const baseFiles = listing.stdout.split('\0').filter((name) => name.length > 0);

  // Read a base-revision file through `git show`, never from the worktree: the
  // integration worktree holds the combined tree, and the surface must be the
  // one the base revision defined.
  const readBaseFile = async (relativePath: string): Promise<string | null> => {
    const shown = await git(['show', `${baseRevision}:${relativePath}`], { cwd: workspacePath, maxOutputBytes: 1024 * 1024 });
    return shown.ok ? shown.stdout : null;
  };

  let packageManifest: string | null = null;
  if (baseFiles.includes('package.json')) packageManifest = await readBaseFile('package.json');

  const diff = await git(['diff', '--name-status', '-z', `${baseRevision}..${combinedRevision}`], { cwd: workspacePath, maxOutputBytes: 8 * 1024 * 1024 });
  if (!diff.ok) return unmeasured(`the diff ${baseRevision}..${combinedRevision} could not be read (${diff.stderr.trim().split('\n')[0] ?? 'git diff failed'})`);
  const fields = diff.stdout.split('\0').filter((field) => field.length > 0);
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      // Rename/copy carries two paths: the old one is a modification of the surface.
      const from = fields[i + 1];
      const to = fields[i + 2];
      if (from !== undefined) changes.push({ status, path: from });
      if (to !== undefined) changes.push({ status: 'A', path: to });
      i += 2;
      continue;
    }
    const file = fields[i + 1];
    if (file !== undefined) changes.push({ status, path: file });
    i += 1;
  }

  const surface = await resolveAcceptanceSurface(checks, baseFiles, { packageManifest, readBaseFile });
  const findings = findSurfaceChanges(surface, changes);
  // What the walk could not settle. A partial surface is a partial comparison,
  // so it refuses the combination rather than being noted beside an
  // "accepted" — the single-task path draws the line in the same place.
  const surfaceGaps = [...surface.resolution.unresolved];
  if (surface.resolution.truncated) {
    surfaceGaps.push(
      `the acceptance surface for this combination is PARTIAL: the walk from ${surface.resolution.entryPoints.length} entry point(s) read ${surface.resolution.filesVisited} file(s) and stopped at a cap, so files a criterion executes may be missing from the fixture comparison`,
    );
  }
  return { mutations: findings.mutations, definitionChanges: findings.definitionChanges, surfaceGaps, blockers: surfaceBlockers(surface) };
}
