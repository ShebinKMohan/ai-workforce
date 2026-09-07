/**
 * Handoff packets (FR034).
 *
 * A packet is everything a second attempt needs to continue work a first
 * attempt started, expressed in terms only the coordinator owns: the original
 * request, the task contract and its version, the base and candidate
 * revisions, an immutable patch reference, findings with source references,
 * the checks that actually executed, what remains, the scope limits and where
 * the artifacts are.
 *
 * It is RUNTIME-NEUTRAL by construction. There is no field for a provider
 * session id, conversation handle, or any other opaque runtime state, and the
 * schema is strict, so such a field cannot be smuggled in. A packet built from
 * a Codex attempt starts a Claude Code attempt without translation.
 */
import { z } from 'zod';
import {
  ContractValidationError,
  IdSchema,
  TaskContractSchema,
  formatZodIssues,
  type TaskContract,
} from '../core/contracts.js';

export const HANDOFF_PACKET_VERSION = 1 as const;

/** Where a finding came from. References are to files, checks or artifacts — never to runtime state. */
export const FindingSourceSchema = z.strictObject({
  kind: z.enum(['file', 'check', 'artifact', 'request']),
  ref: z.string().min(1),
  line: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  revision: z.string().min(1).optional(),
  excerpt: z.string().max(2000).optional(),
});
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const FindingSchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(['blocker', 'major', 'minor', 'info']),
  summary: z.string().min(1),
  detail: z.string().optional(),
  sources: z.array(FindingSourceSchema).min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A check the verifier executed. Provenance is recorded so nothing is taken on a runtime's word. */
export const ExecutedCheckSchema = z.strictObject({
  criterionId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  outcome: z.enum(['passed', 'failed', 'timeout', 'error', 'integrity_failed', 'no_tests_executed', 'skipped']),
  required: z.boolean(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  testsRun: z.number().int().min(0).nullable().default(null),
  evidenceProvenance: z.literal('verifier_executed'),
  stdoutPath: z.string().min(1).optional(),
  stderrPath: z.string().min(1).optional(),
  failureTail: z.string().max(4000).optional(),
});
export type ExecutedCheck = z.infer<typeof ExecutedCheckSchema>;

export const RemainingWorkSchema = z.strictObject({
  id: z.string().min(1).max(128),
  description: z.string().min(1),
  blockedBy: z.array(z.string().min(1)).default([]),
  acceptanceCriterionId: z.string().min(1).optional(),
});
export type RemainingWork = z.infer<typeof RemainingWorkSchema>;

export const ArtifactLocationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1).optional(),
  bytes: z.number().int().min(0).optional(),
});
export type ArtifactLocation = z.infer<typeof ArtifactLocationSchema>;

/** An immutable reference to the work produced so far: a content hash, not a mutable branch name. */
export const PatchReferenceSchema = z.strictObject({
  format: z.enum(['git-diff', 'git-bundle', 'none']),
  /** Content hash of the patch bytes. Required whenever a patch exists. */
  hash: z.string().min(1).nullable(),
  /** Coordinator-owned artifact id or absolute path holding the patch bytes. */
  ref: z.string().min(1).nullable(),
  bytes: z.number().int().min(0).optional(),
});
export type PatchReference = z.infer<typeof PatchReferenceSchema>;

export const ScopeLimitsSchema = z.strictObject({
  policy: z.enum(['analysis', 'local-development', 'verification']),
  allowedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([]),
  notes: z.array(z.string().min(1)).default([]),
});
export type ScopeLimits = z.infer<typeof ScopeLimitsSchema>;

/**
 * Provenance only. A consumer must never require these to continue: they say
 * who produced the packet, not how to resume anything.
 */
export const HandoffProvenanceSchema = z.strictObject({
  agentId: z.string().min(1).optional(),
  adapterId: z.enum(['codex', 'claude-code', 'fake']).optional(),
  adapterVersion: z.string().min(1).optional(),
  attemptNumber: z.number().int().min(1).optional(),
});
export type HandoffProvenance = z.infer<typeof HandoffProvenanceSchema>;

export const HandoffPacketSchema = z
  .strictObject({
    packetVersion: z.literal(HANDOFF_PACKET_VERSION),
    createdAt: z.string().datetime(),
    runId: IdSchema,
    taskId: IdSchema,
    originalRequest: z.strictObject({
      text: z.string().min(1),
      contextRefs: z.array(z.string().min(1)).default([]),
    }),
    contract: TaskContractSchema,
    /** Copy of `contract.contractVersion`, kept explicit so a reader need not parse the contract. */
    contractVersion: z.number().int().min(1),
    revisions: z.strictObject({
      repoPath: z.string().min(1),
      base: z.string().min(1),
      candidate: z.string().min(1).nullable(),
    }),
    patch: PatchReferenceSchema,
    findings: z.array(FindingSchema).default([]),
    checks: z.array(ExecutedCheckSchema).default([]),
    remainingWork: z.array(RemainingWorkSchema).default([]),
    scopeLimits: ScopeLimitsSchema,
    artifacts: z.array(ArtifactLocationSchema).default([]),
    producedBy: HandoffProvenanceSchema.default({}),
  })
  .superRefine((packet, ctx) => {
    if (packet.contractVersion !== packet.contract.contractVersion) {
      ctx.addIssue({
        code: 'custom',
        path: ['contractVersion'],
        message: `contractVersion ${packet.contractVersion} does not match contract.contractVersion ${packet.contract.contractVersion}`,
      });
    }
    if (packet.patch.format !== 'none' && (packet.patch.hash === null || packet.patch.ref === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'a patch with a format must carry both a content hash and a reference; an unhashed patch is not an immutable reference',
      });
    }
    const criterionIds = new Set(packet.contract.acceptanceCriteria.map((c) => c.id));
    packet.remainingWork.forEach((item, index) => {
      if (item.acceptanceCriterionId !== undefined && !criterionIds.has(item.acceptanceCriterionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['remainingWork', index, 'acceptanceCriterionId'],
          message: `references acceptance criterion "${item.acceptanceCriterionId}", which the contract does not define`,
        });
      }
    });
  });
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;
export type HandoffPacketInput = z.input<typeof HandoffPacketSchema>;

/** Validate an untrusted packet (for example one read back from disk). */
export function parseHandoffPacket(input: unknown): HandoffPacket {
  const result = HandoffPacketSchema.safeParse(input);
  if (!result.success) throw new ContractValidationError('handoff packet', formatZodIssues(result.error.issues));
  return result.data;
}

/** Build and validate a packet. Throws `ContractValidationError` with specific issues. */
export function buildHandoffPacket(input: HandoffPacketInput): HandoffPacket {
  return parseHandoffPacket(input);
}

export function serializeHandoffPacket(packet: HandoffPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Applying a packet to a fresh attempt
// ---------------------------------------------------------------------------

export interface ApplyHandoffOptions {
  /**
   * True when the receiving runtime enforces write containment itself. Only
   * changes the wording of the scope reminder; the coordinator enforces the
   * boundary either way.
   */
  readonly runtimeEnforcesWrites?: boolean;
  readonly maxFindings?: number;
}

export interface HandoffBrief {
  readonly packetVersion: typeof HANDOFF_PACKET_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly contract: TaskContract;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly patch: PatchReference;
  readonly baseRevision: string;
  readonly candidateRevision: string | null;
  /** Runtime-neutral continuation prompt. Contains no session id and no provider state. */
  readonly prompt: string;
  readonly failedCheckCommands: ReadonlyArray<string>;
}

/**
 * Turn a packet into the inputs for a fresh attempt on any runtime. The result
 * carries no session identity: continuation is reconstructed from the patch
 * reference and the contract, so any adapter can pick it up.
 */
export function applyHandoffPacket(packet: HandoffPacket, options: ApplyHandoffOptions = {}): HandoffBrief {
  const maxFindings = options.maxFindings ?? 20;
  const failed = packet.checks.filter((c) => c.outcome !== 'passed' && c.outcome !== 'skipped');
  const lines: string[] = [];

  lines.push('You are continuing work another worker started. Nothing below is your own memory; it is recorded evidence.');
  lines.push('');
  lines.push('## Original request (verbatim)');
  lines.push(packet.originalRequest.text);
  lines.push('');
  lines.push(`## Task contract (version ${packet.contractVersion})`);
  lines.push(`Objective: ${packet.contract.objective}`);
  if (packet.contract.constraints.length > 0) {
    lines.push('Constraints:');
    for (const constraint of packet.contract.constraints) lines.push(`  - ${constraint}`);
  }
  if (packet.contract.acceptanceCriteria.length > 0) {
    lines.push('Acceptance criteria:');
    for (const criterion of packet.contract.acceptanceCriteria) lines.push(`  - ${criterion.id}: ${criterion.description}`);
  }
  lines.push('');
  lines.push('## Where the work stands');
  lines.push(`Base revision: ${packet.revisions.base}`);
  lines.push(`Candidate revision: ${packet.revisions.candidate ?? '(no candidate commit yet)'}`);
  lines.push(
    packet.patch.format === 'none'
      ? 'Patch: none was produced; start from the base revision.'
      : `Patch: ${packet.patch.format} at ${packet.patch.ref ?? '(unreferenced)'} (content hash ${packet.patch.hash ?? '(none)'}). It is already applied in your workspace.`,
  );
  lines.push('');

  if (packet.findings.length > 0) {
    lines.push('## Findings from the previous attempt');
    for (const finding of packet.findings.slice(0, maxFindings)) {
      const sources = finding.sources.map((s) => `${s.kind}:${s.ref}${s.line === undefined ? '' : `:${s.line}`}`).join(', ');
      lines.push(`- [${finding.severity}] ${finding.summary} (${sources})`);
      if (finding.detail !== undefined) lines.push(`  ${finding.detail}`);
    }
    lines.push('');
  }

  lines.push('## Checks the verifier executed');
  if (packet.checks.length === 0) {
    lines.push('None were executed, so nothing about this candidate has been demonstrated.');
  } else {
    for (const check of packet.checks) {
      lines.push(`- ${check.criterionId}: \`${[check.command, ...check.args].join(' ')}\` -> ${check.outcome}${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`);
      if (check.failureTail !== undefined && check.outcome !== 'passed') lines.push(`  last output: ${check.failureTail}`);
    }
  }
  lines.push('');

  if (packet.remainingWork.length > 0) {
    lines.push('## Remaining work');
    for (const item of packet.remainingWork) {
      const blocked = item.blockedBy.length > 0 ? ` (blocked by ${item.blockedBy.join(', ')})` : '';
      lines.push(`- ${item.description}${blocked}`);
    }
    lines.push('');
  }

  if (packet.artifacts.length > 0) {
    lines.push('## Artifacts');
    for (const artifact of packet.artifacts) lines.push(`- ${artifact.kind} ${artifact.id}: ${artifact.path}`);
    lines.push('');
  }

  lines.push('## Scope limits');
  lines.push(`Policy: ${packet.scopeLimits.policy}`);
  lines.push(
    packet.scopeLimits.allowedPaths.length === 0
      ? 'Allowed paths: the whole candidate workspace.'
      : `Allowed paths: ${packet.scopeLimits.allowedPaths.join(', ')}`,
  );
  if (packet.scopeLimits.forbiddenPaths.length > 0) lines.push(`Forbidden paths: ${packet.scopeLimits.forbiddenPaths.join(', ')}`);
  for (const note of packet.scopeLimits.notes) lines.push(`- ${note}`);
  lines.push(
    options.runtimeEnforcesWrites === true
      ? 'Writes outside those paths are refused by the runtime and by the coordinator.'
      : 'Writes outside those paths are detected and rejected by the coordinator; staying inside them is your responsibility.',
  );
  lines.push('');
  lines.push('Declaring the work done does not accept it: only the executed checks above decide.');

  return {
    packetVersion: packet.packetVersion,
    runId: packet.runId,
    taskId: packet.taskId,
    contract: packet.contract,
    allowedPaths: packet.scopeLimits.allowedPaths,
    forbiddenPaths: packet.scopeLimits.forbiddenPaths,
    patch: packet.patch,
    baseRevision: packet.revisions.base,
    candidateRevision: packet.revisions.candidate,
    prompt: lines.join('\n'),
    failedCheckCommands: failed.map((c) => [c.command, ...c.args].join(' ')),
  };
}

// ---------------------------------------------------------------------------
// Adapters from coordinator records
// ---------------------------------------------------------------------------

/** Shape of a verifier check receipt, narrowed to what a packet records. */
export interface CheckReceiptLike {
  readonly criterionId: string;
  readonly required: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly outcome: ExecutedCheck['outcome'];
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly evidenceProvenance: 'verifier_executed';
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly stderrTail?: string;
  readonly stdoutTail?: string;
  readonly outputSummary?: { readonly testsRun: number | null };
}

/** Convert a verifier receipt into a packet check entry (drops paths-only detail). */
export function executedCheckFromReceipt(receipt: CheckReceiptLike): ExecutedCheck {
  const tail = (receipt.stderrTail ?? '').trim() || (receipt.stdoutTail ?? '').trim();
  return ExecutedCheckSchema.parse({
    criterionId: receipt.criterionId,
    command: receipt.command,
    args: [...receipt.args],
    outcome: receipt.outcome,
    required: receipt.required,
    exitCode: receipt.exitCode,
    startedAt: receipt.startedAt,
    endedAt: receipt.endedAt,
    durationMs: receipt.durationMs,
    testsRun: receipt.outputSummary?.testsRun ?? null,
    evidenceProvenance: receipt.evidenceProvenance,
    ...(receipt.stdoutPath === undefined ? {} : { stdoutPath: receipt.stdoutPath }),
    ...(receipt.stderrPath === undefined ? {} : { stderrPath: receipt.stderrPath }),
    ...(tail.length === 0 ? {} : { failureTail: tail.slice(-4000) }),
  });
}
