/**
 * Versioned, validated contracts exchanged at application boundaries.
 *
 * Everything here is pure: zod schemas, inferred types and formatting of
 * validation failures into actionable messages. File loading lives in
 * `config.ts`; persistence lives in `../storage`.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const IdSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof IdSchema>;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_HINT = 'letters, digits, ".", "_" or "-" and must start with a letter or digit';

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAME_PATTERN, { message: `agent ids use ${NAME_HINT}` });

export const RuntimeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAME_PATTERN, { message: `runtime ids use ${NAME_HINT}` });

/** Adapters the coordinator knows how to drive. `fake` is the deterministic test runtime. */
export const AdapterIdSchema = z.enum(['codex', 'claude-code', 'fake']);
export type AdapterId = z.infer<typeof AdapterIdSchema>;

/** Execution profiles enforced outside prompts (plan section 8). */
export const PolicySchema = z.enum(['analysis', 'local-development', 'verification']);
export type Policy = z.infer<typeof PolicySchema>;

/** Effort is a runtime-specific string; the adapter validates it (FR006). */
export const EffortSchema = z.string().min(1).max(32);
export const ModelSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// Policy profiles (data the adapters and verifier enforce)
// ---------------------------------------------------------------------------

export interface PolicyProfile {
  readonly policy: Policy;
  /** Worker may write to the assigned candidate workspace. */
  readonly writeCandidate: boolean;
  /** Worker may write private scratch/build paths allocated for the attempt. */
  readonly writeScratch: boolean;
  /** Worker may execute tools/tests inside the verified runtime boundary. */
  readonly executeTools: boolean;
  /** Repository hooks/tests may run with the worker's privileges. */
  readonly executeRepositoryHooks: boolean;
  /** Network policy for worker tools (provider inference traffic is separate). */
  readonly workerNetwork: 'denied' | 'project_allowlist' | 'criterion_endpoint_only';
  /** Publish credentials, push, merge or deployment are never available in the MVP. */
  readonly externalDelivery: false;
}

export const POLICY_PROFILES: Readonly<Record<Policy, PolicyProfile>> = {
  analysis: {
    policy: 'analysis',
    writeCandidate: false,
    writeScratch: true,
    executeTools: true,
    executeRepositoryHooks: false,
    workerNetwork: 'denied',
    externalDelivery: false,
  },
  'local-development': {
    policy: 'local-development',
    writeCandidate: true,
    writeScratch: true,
    executeTools: true,
    executeRepositoryHooks: true,
    workerNetwork: 'project_allowlist',
    externalDelivery: false,
  },
  verification: {
    policy: 'verification',
    writeCandidate: false,
    writeScratch: true,
    executeTools: true,
    executeRepositoryHooks: true,
    workerNetwork: 'criterion_endpoint_only',
    externalDelivery: false,
  },
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const limitsShape = {
  maxActiveTurns: z.number().int().min(1).max(64),
  maxActiveWriters: z.number().int().min(1).max(64),
  maxTasksPerRun: z.number().int().min(1).max(1000),
  maxDelegationDepth: z.number().int().min(0).max(16),
  maxRepairAttempts: z.number().int().min(0).max(100),
  maxTransientRetries: z.number().int().min(0).max(100),
  runTimeoutMinutes: z.number().int().min(1).max(24 * 60 * 7),
} as const;

/** Observable execution limits enforced by the coordinator (FR014). */
export const LimitsSchema = z.strictObject(limitsShape);
export type Limits = z.infer<typeof LimitsSchema>;

export const LIMIT_KEYS = Object.keys(limitsShape) as ReadonlyArray<keyof Limits>;

// ---------------------------------------------------------------------------
// Agent configuration file (schemaVersion 1) — FR011, FR012
// ---------------------------------------------------------------------------

export const AGENT_CONFIG_SCHEMA_VERSION = 1 as const;

export const RuntimeConfigSchema = z.strictObject({
  adapter: AdapterIdSchema,
  executable: z.string().min(1),
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const DefaultsSchema = z.strictObject({
  workerAgent: AgentIdSchema,
  plannerAgent: AgentIdSchema.optional(),
  reviewerAgent: AgentIdSchema.optional(),
  ...limitsShape,
});
export type Defaults = z.infer<typeof DefaultsSchema>;

export const AgentDefinitionSchema = z.strictObject({
  id: AgentIdSchema,
  runtime: RuntimeIdSchema,
  instructions: z.string().min(1),
  capabilities: z.array(z.string().min(1).max(64)).max(32),
  policy: PolicySchema,
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const AgentConfigFileShape = z.strictObject({
  schemaVersion: z.literal(AGENT_CONFIG_SCHEMA_VERSION),
  runtimes: z.record(RuntimeIdSchema, RuntimeConfigSchema),
  defaults: DefaultsSchema,
  agents: z.array(AgentDefinitionSchema).min(1),
});

/**
 * Cross-reference validation. These checks run only when the structural
 * checks passed, so every message can rely on well-formed fields.
 */
export const AgentConfigFileSchema = AgentConfigFileShape.superRefine((config, ctx) => {
  const runtimeIds = Object.keys(config.runtimes);
  if (runtimeIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['runtimes'],
      message: 'at least one runtime must be defined (for example {"codex-local": {"adapter": "codex", "executable": "codex"}})',
    });
  }

  const seen = new Map<string, number>();
  config.agents.forEach((agent, index) => {
    const firstIndex = seen.get(agent.id);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['agents', index, 'id'],
        message: `duplicate agent id "${agent.id}" (first defined at agents[${firstIndex}]); agent ids must be unique`,
      });
    } else {
      seen.set(agent.id, index);
    }
    if (!(agent.runtime in config.runtimes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['agents', index, 'runtime'],
        message: `agent "${agent.id}" references unknown runtime "${agent.runtime}"; known runtimes: ${formatList(runtimeIds)}`,
      });
    }
  });

  const agentIds = [...seen.keys()];
  for (const role of ['workerAgent', 'plannerAgent', 'reviewerAgent'] as const) {
    const ref = config.defaults[role];
    if (ref !== undefined && !seen.has(ref)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaults', role],
        message: `references unknown agent "${ref}"; known agents: ${formatList(agentIds)}`,
      });
    }
  }
});
export type AgentConfigFile = z.infer<typeof AgentConfigFileShape>;

// ---------------------------------------------------------------------------
// Effective agent binding and immutable snapshot — FR012, FR015
// ---------------------------------------------------------------------------

export const EFFECTIVE_BINDING_VERSION = 1 as const;

export const EffectiveAgentBindingSchema = z.strictObject({
  bindingVersion: z.literal(EFFECTIVE_BINDING_VERSION),
  agentId: AgentIdSchema,
  instructions: z.string().min(1),
  capabilities: z.array(z.string()),
  policy: PolicySchema,
  runtime: z.strictObject({
    id: RuntimeIdSchema,
    adapter: AdapterIdSchema,
    executable: z.string().min(1),
    model: ModelSchema.optional(),
    effort: EffortSchema.optional(),
  }),
  limits: LimitsSchema,
});
export type EffectiveAgentBinding = z.infer<typeof EffectiveAgentBindingSchema>;

export interface AgentSnapshot {
  /** sha256 of the canonical JSON of `binding`. */
  readonly hash: string;
  readonly binding: EffectiveAgentBinding;
  /** The exact canonical JSON that was hashed; persist this, not a re-serialization. */
  readonly canonicalJson: string;
}

// ---------------------------------------------------------------------------
// Task contract v1 — FR022
// ---------------------------------------------------------------------------

export const TASK_CONTRACT_VERSION = 1 as const;

export const CheckCommandSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
});
export type CheckCommand = z.infer<typeof CheckCommandSchema>;

export const AcceptanceCriterionSchema = z.strictObject({
  id: z.string().min(1).max(64).regex(NAME_PATTERN, { message: `criterion ids use ${NAME_HINT}` }),
  description: z.string().min(1),
  check: CheckCommandSchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TaskDependencySchema = z.strictObject({
  taskId: IdSchema,
  /** Required producer artifact type or interface name, when more than task completion is needed. */
  artifact: z.string().min(1).optional(),
  interface: z.string().min(1).optional(),
  /** Required producer contract/artifact version; readiness refers to a version, not a process exit. */
  version: z.number().int().min(1).optional(),
});
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const TaskScopeSchema = z.strictObject({
  description: z.string().optional(),
  allowedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([]),
});
export type TaskScope = z.infer<typeof TaskScopeSchema>;

export const TaskContractSchema = z
  .strictObject({
    contractVersion: z.number().int().min(1),
    objective: z.string().min(1),
    scope: TaskScopeSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
    dependencies: z.array(TaskDependencySchema).default([]),
    constraints: z.array(z.string().min(1)).default([]),
    evidenceRequirements: z.array(z.string().min(1)).default([]),
  })
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    contract.acceptanceCriteria.forEach((criterion, index) => {
      if (seen.has(criterion.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptanceCriteria', index, 'id'],
          message: `duplicate acceptance criterion id "${criterion.id}"`,
        });
      }
      seen.add(criterion.id);
    });
  });
export type TaskContract = z.infer<typeof TaskContractSchema>;
export type TaskContractInput = z.input<typeof TaskContractSchema>;

// ---------------------------------------------------------------------------
// Run request (request.json) — FR020 foundation
// ---------------------------------------------------------------------------

export const RUN_REQUEST_VERSION = 1 as const;

export const RuntimeAttachmentSchema = z.strictObject({
  path: z.string().min(1).max(4096).refine((value) => !value.includes('\0')),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().max(10 * 1024 * 1024).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mode: z.enum(['auto', 'native', 'reference']).optional(),
});

export const RunRequestSchema = z.strictObject({
  requestVersion: z.literal(RUN_REQUEST_VERSION),
  runId: IdSchema,
  /** The user's original wording, never rewritten. */
  text: z.string().min(1),
  contextRefs: z.array(z.string().min(1)).default([]),
  attachments: z.array(RuntimeAttachmentSchema).max(8).optional(),
  repoPath: z.string().min(1),
  baseMode: z.enum(['head']).default('head'),
  submittedAt: z.string().datetime(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

// ---------------------------------------------------------------------------
// Lifecycle states (plan section 8)
// ---------------------------------------------------------------------------

export const TaskStateSchema = z.enum([
  'pending',
  'ready',
  'running',
  'validating',
  'accepted',
  'waiting',
  'failed',
  'cancelled',
  'superseded',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const WaitReasonSchema = z.enum(['dependency', 'peer', 'user_intent', 'provider', 'pause']);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

/** A task state together with the mandatory reason when waiting. */
export const TaskStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('waiting'), reason: WaitReasonSchema }),
  z.strictObject({ state: TaskStateSchema.exclude(['waiting']) }),
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RunStateSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'ready_for_review',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const AttemptStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'superseded',
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Thrown when a boundary contract is invalid; `issues` are user-facing. */
export class ContractValidationError extends Error {
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly contractName: string;

  constructor(contractName: string, issues: ReadonlyArray<ValidationIssue>) {
    super(`${contractName} is invalid:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ContractValidationError';
    this.contractName = contractName;
    this.issues = issues;
  }
}

export function formatZodIssues(issues: ReadonlyArray<z.core.$ZodIssue>): ValidationIssue[] {
  return issues.map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : formatPath(issue.path);
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((k) => `"${k}"`).join(', ');
      return { path, message: `unknown field${issue.keys.length > 1 ? 's' : ''} ${keys}; remove or rename (unknown fields are rejected before execution)` };
    }
    if (issue.code === 'invalid_type' && issue.message.includes('received undefined')) {
      return { path, message: `missing required field (${issue.message})` };
    }
    return { path, message: issue.message };
  });
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function formatList(items: ReadonlyArray<string>): string {
  return items.length === 0 ? '(none)' : items.map((i) => `"${i}"`).join(', ');
}

function validateWith<S extends z.ZodType>(schema: S, contractName: string, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ContractValidationError(contractName, formatZodIssues(result.error.issues));
  return result.data;
}

/** Validate an agent configuration document (schemaVersion 1) before any execution. */
export function validateAgentConfig(input: unknown): AgentConfigFile {
  return validateWith(AgentConfigFileSchema, 'agent configuration', input);
}

export function validateTaskContract(input: unknown): TaskContract {
  return validateWith(TaskContractSchema, 'task contract', input);
}

export function validateRunRequest(input: unknown): RunRequest {
  return validateWith(RunRequestSchema, 'run request', input);
}

export function validateEffectiveBinding(input: unknown): EffectiveAgentBinding {
  return validateWith(EffectiveAgentBindingSchema, 'effective agent binding', input);
}

/** Pick the limits subset out of the defaults block. */
export function limitsFromDefaults(defaults: Defaults): Limits {
  const out: Partial<Record<keyof Limits, number>> = {};
  for (const key of LIMIT_KEYS) out[key] = defaults[key];
  return out as Limits;
}
