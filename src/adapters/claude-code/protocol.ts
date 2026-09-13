/**
 * Wire protocol for the Claude Code CLI's documented programmatic mode
 * (`claude --print --output-format stream-json`), as observed on the installed
 * build 2.1.260 on darwin.
 *
 * Everything modelled here was read off the installed executable: its own
 * `--help`, and recorded stdout/stdin frames. Where a shape could not be
 * observed on this machine (a turn that reaches the model), the schema stays
 * loose and the adapter records the record verbatim rather than asserting a
 * shape it has not seen. Every schema is a loose object: the CLI is versioned
 * independently of us and adds fields freely, so unknown fields are preserved
 * rather than rejected (plan section 6: "unknown event fields must not crash a
 * compatible stream").
 *
 * Three properties of the installed build shape the whole design:
 *   - stdout is newline-delimited JSON *mixed with plain text*: a resume of an
 *     unknown session id printed `No conversation found with session ID: …` as
 *     a bare line before the JSON result. Non-JSON lines are evidence, not
 *     errors.
 *   - stdin is newline-delimited JSON too, and a line the CLI cannot parse
 *     makes it log `Error parsing streaming input line` and exit. The encoder
 *     below is the only place that writes to it.
 *   - `--effort <unknown>` prints a warning and silently falls back to the
 *     default effort, so unknown effort values must be refused before spawn
 *     (plan section 8: "Do not silently map unsupported reasoning levels").
 */
import { z } from 'zod';
import type { Policy } from '../../core/contracts.js';

export const CLAUDE_CODE_ADAPTER = 'claude-code' as const;
export const DEFAULT_CLAUDE_EXECUTABLE = 'claude';

/** The version this adapter's capability statuses were established against. */
export const TESTED_CLAUDE_VERSION = '2.1.260';

/** `claude --version` prints `2.1.260 (Claude Code)`. */
export const CLAUDE_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\s*\(Claude Code\)/i;

export function parseClaudeVersion(output: string): string | null {
  const match = CLAUDE_VERSION_PATTERN.exec(output);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// stdout records (`--output-format stream-json`)
// ---------------------------------------------------------------------------

export const STREAM_RECORD_TYPES = ['system', 'assistant', 'user', 'result', 'control_response', 'control_request', 'stream_event'] as const;

/** Streaming chunk records; noisy, and filtered from the normalized stream unless `includeDeltas` is set. */
const DELTA_RECORD_TYPES = new Set(['stream_event']);

export function isDeltaRecord(type: string): boolean {
  return DELTA_RECORD_TYPES.has(type);
}

export const SystemInitSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string(),
  session_id: z.string().nullish(),
  cwd: z.string().nullish(),
  tools: z.array(z.string()).nullish(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string().nullish() })).nullish(),
  model: z.string().nullish(),
  permissionMode: z.string().nullish(),
  apiKeySource: z.string().nullish(),
  claude_code_version: z.string().nullish(),
  output_style: z.string().nullish(),
  capabilities: z.array(z.string()).nullish(),
  agents: z.array(z.string()).nullish(),
  uuid: z.string().nullish(),
});
export type SystemInit = z.infer<typeof SystemInitSchema>;

/** One block of an assistant message. `input` is unknown: tool schemas are the tools' business, not ours. */
export const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().nullish(),
  name: z.string().nullish(),
  id: z.string().nullish(),
  input: z.unknown().optional(),
  tool_use_id: z.string().nullish(),
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
});
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.looseObject({
  role: z.string().nullish(),
  id: z.string().nullish(),
  model: z.string().nullish(),
  stop_reason: z.unknown().optional(),
  content: z.union([z.string(), z.array(ContentBlockSchema)]).nullish(),
  usage: z.unknown().optional(),
});

export const AssistantRecordSchema = z.looseObject({
  type: z.literal('assistant'),
  message: MessageSchema,
  session_id: z.string().nullish(),
  parent_tool_use_id: z.string().nullish(),
  uuid: z.string().nullish(),
  timestamp: z.string().nullish(),
  /** Present on synthetic API-error messages, e.g. `authentication_failed`. */
  error: z.string().nullish(),
  is_api_error_message: z.boolean().nullish(),
});
export type AssistantRecord = z.infer<typeof AssistantRecordSchema>;

export const UserRecordSchema = z.looseObject({
  type: z.literal('user'),
  message: MessageSchema,
  session_id: z.string().nullish(),
  parent_tool_use_id: z.string().nullish(),
  uuid: z.string().nullish(),
  /** Set by `--replay-user-messages`: the CLI acknowledging a message we wrote to its stdin. */
  isReplay: z.boolean().nullish(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const UsageSchema = z.looseObject({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
});

/**
 * The terminal record of a turn.
 *
 * Every known field is `nullish`, not `optional`. A field a CLI emits as JSON
 * `null` when it has no value is an ordinary evolution of a CLI versioned
 * independently of us, and `z.number().optional()` rejects `null` — which
 * would demote the one record that ends a turn to an unparsed blob and leave
 * the turn open until the run deadline. The adapter additionally treats *any*
 * record whose `type` is `result` as terminal even when this schema rejects it
 * (plan section 9: "Malformed structured result — retain raw output; … fail
 * with protocol diagnostics"), so this is defence in depth rather than the
 * only guard.
 */
export const ResultRecordSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  session_id: z.string().nullish(),
  is_error: z.boolean().nullish(),
  result: z.string().nullish(),
  errors: z.array(z.unknown()).nullish(),
  num_turns: z.number().nullish(),
  duration_ms: z.number().nullish(),
  duration_api_ms: z.number().nullish(),
  total_cost_usd: z.number().nullish(),
  usage: UsageSchema.nullish(),
  modelUsage: z.unknown().optional(),
  permission_denials: z.array(z.unknown()).nullish(),
  terminal_reason: z.string().nullish(),
  queued_turn_count: z.number().nullish(),
  stop_reason: z.unknown().optional(),
  uuid: z.string().nullish(),
});
export type ResultRecord = z.infer<typeof ResultRecordSchema>;

export const ControlResponseSchema = z.looseObject({
  type: z.literal('control_response'),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    response: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
});
export type ControlResponse = z.infer<typeof ControlResponseSchema>;

/** Minimal envelope used to route a decoded record; every record carries a `type`. */
export const StreamEnvelopeSchema = z.looseObject({ type: z.string() });

export type DecodedLine =
  | { readonly kind: 'record'; readonly type: string; readonly value: Record<string, unknown> }
  /** Valid JSON that is not an object with a string `type` (the CLI has never produced one; kept as evidence). */
  | { readonly kind: 'foreign'; readonly value: unknown }
  /** Not JSON at all. The CLI does print bare text lines on stdout; they are evidence, not a crash. */
  | { readonly kind: 'text'; readonly line: string };

export function decodeStreamLine(line: string): DecodedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'text', line };
  }
  const envelope = StreamEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return { kind: 'foreign', value: parsed };
  return { kind: 'record', type: envelope.data.type, value: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// stdin frames (`--input-format stream-json`)
// ---------------------------------------------------------------------------

/** MessageParam content from the documented Agent SDK streaming input API.
 * https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 * https://platform.claude.com/docs/en/api/typescript/messages
 */
export type UserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; readonly data: string } }
  | { readonly type: 'document'; readonly title: string; readonly source: { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string } };

export interface UserFrame {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: ReadonlyArray<UserContentBlock> };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
}

export function userFrame(sessionId: string, content: string | ReadonlyArray<UserContentBlock>): UserFrame {
  return { type: 'user', message: { role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content }, parent_tool_use_id: null, session_id: sessionId };
}

export interface ControlRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: string } & Record<string, unknown>;
}

export function controlRequestFrame(requestId: string, subtype: string, extra: Record<string, unknown> = {}): ControlRequestFrame {
  return { type: 'control_request', request_id: requestId, request: { subtype, ...extra } };
}

/** Control subtypes this adapter sends. Both were exercised against the installed build. */
export const CONTROL_SUBTYPE = {
  /**
   * Returns commands, agents, models (with `supportedEffortLevels`), an
   * `account` block, `pid` and `current_permission_mode`. No model turn.
   *
   * The account block is NOT uniform: on 2.1.260 a signed-out CLI reports
   * `tokenSource: "none"` and a signed-in one omits `tokenSource` entirely,
   * naming the account instead (`email`, `organization`, `subscriptionType`,
   * `apiProvider`). Absence of the field therefore says nothing on its own —
   * see `readClaudeCredential`.
   */
  initialize: 'initialize',
  /** Returns `{ still_queued: [...] }`; `interrupt_cancel_queued_v1` in the init `capabilities` array names this behaviour. */
  interrupt: 'interrupt',
} as const;

/** Shape of the `initialize` control response payload we read. Everything else is kept raw. */
export const InitializeResponseSchema = z.looseObject({
  models: z
    .array(
      z.looseObject({
        value: z.string().min(1),
        resolvedModel: z.string().optional(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        supportsEffort: z.boolean().optional(),
        supportedEffortLevels: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  account: z
    .looseObject({
      tokenSource: z.string().optional(),
      apiProvider: z.string().optional(),
      email: z.string().optional(),
      organization: z.string().optional(),
      subscriptionType: z.string().optional(),
    })
    .optional(),
  output_style: z.string().optional(),
  current_permission_mode: z.string().optional(),
  session_state: z.string().optional(),
  pid: z.number().optional(),
});
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

/**
 * Whether the runtime holds a credential it can spend, as far as its own
 * `initialize` response says.
 *
 * `unknown` is a real answer and the reason this function exists. The first
 * WP05 recording read a *missing* `account.tokenSource` as "no credential",
 * which is exactly backwards on claude 2.1.260: the field appears with the
 * value `"none"` when the CLI is signed out and is absent when it is signed
 * in. That inversion made the gated model-turn checks skip themselves on a
 * working machine and stamped "the runtime holds no usable credential" into a
 * recorded evidence file as observed fact.
 *
 * Executed on claude 2.1.260 / darwin, signed in with claude.ai:
 * `{"email":"…","organization":"…","subscriptionType":"Claude Max","apiProvider":"firstParty"}`
 * — no `tokenSource` key at all.
 */
export interface ClaudeCredentialReport {
  readonly state: 'usable' | 'none' | 'unknown';
  readonly tokenSource: string | null;
  readonly apiProvider: string | null;
  readonly subscriptionType: string | null;
  /** True when the account block names an account (an email or a subscription), whatever the token source says. */
  readonly identified: boolean;
  /** One sentence naming the evidence, for a diagnostic or a skip reason. */
  readonly detail: string;
}

export function readClaudeCredential(account: InitializeResponse['account']): ClaudeCredentialReport {
  const tokenSource = account?.tokenSource ?? null;
  const apiProvider = account?.apiProvider ?? null;
  const subscriptionType = account?.subscriptionType ?? null;
  const identified = (account?.email ?? '').length > 0 || (subscriptionType ?? '').length > 0;
  const base = { tokenSource, apiProvider, subscriptionType, identified };
  if (account === undefined) {
    return { ...base, state: 'unknown', detail: 'the initialize control response carried no account block, so the runtime said nothing about its credential' };
  }
  if (tokenSource === 'none') {
    return { ...base, state: 'none', detail: 'the runtime reports account.tokenSource "none": it holds no usable credential, whatever `claude auth status` says' };
  }
  if (tokenSource !== null && tokenSource.length > 0) {
    return { ...base, state: 'usable', detail: `the runtime reports account.tokenSource ${JSON.stringify(tokenSource)}` };
  }
  if (identified) {
    return {
      ...base,
      state: 'usable',
      detail:
        `the runtime reports no account.tokenSource and names a signed-in account instead` +
        `${subscriptionType !== null ? ` (subscriptionType ${JSON.stringify(subscriptionType)})` : ''}` +
        `${apiProvider !== null ? `, apiProvider ${JSON.stringify(apiProvider)}` : ''}` +
        '; this build omits the field when it holds a credential and reports "none" when it does not',
    };
  }
  return { ...base, state: 'unknown', detail: 'the initialize control response named no account and no token source, so whether the runtime holds a credential is unknown' };
}

// ---------------------------------------------------------------------------
// Documented value sets (from the installed executable's own `--help`)
// ---------------------------------------------------------------------------

/** `--effort <level>`. An unknown value is warned about and silently ignored, so the adapter refuses one instead. */
export const CLAUDE_EFFORT_LEVELS: ReadonlyArray<string> = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `--permission-mode <mode>` choices, exactly as the installed build lists them. */
export const CLAUDE_PERMISSION_MODES: ReadonlyArray<string> = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

/** Never emitted by this adapter: it removes every permission check, which would leave a writing worker with no boundary at all. */
export const REFUSED_PERMISSION_MODE = 'bypassPermissions';

/**
 * Tool names the adapter grants per profile.
 *
 * `analysis` gets reading tools only. `local-development` adds the two file
 * writers and nothing else: `Bash` is deliberately absent, because granting a
 * shell removes the only write boundary this runtime has (see
 * docs/runtime-claude-code.md, "Containment truth"). `allowCommandExecution`
 * adds it back explicitly and downgrades the containment claim.
 */
export const READ_TOOLS: ReadonlyArray<string> = ['Read', 'Glob', 'Grep'];
export const WRITE_TOOLS: ReadonlyArray<string> = ['Edit', 'Write'];
export const COMMAND_TOOLS: ReadonlyArray<string> = ['Bash'];

/** Tool names whose invocation is a file mutation; used to project `file_change` events. */
export const FILE_MUTATING_TOOLS: ReadonlyArray<string> = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

// ---------------------------------------------------------------------------
// Policy translation (plan section 8)
// ---------------------------------------------------------------------------

export interface PolicyControls {
  readonly permissionMode: string;
  readonly tools: ReadonlyArray<string>;
  /** `--restricted`: confines the file tools to the working directories, ignores user/project/local settings, refuses bypassPermissions. */
  readonly restricted: boolean;
  /** True when the profile is allowed to change files in the granted directories. */
  readonly writeCandidate: boolean;
}

export interface PolicyMapping extends PolicyControls {
  readonly policy: Policy;
  /** Parts of the plan's profile this runtime cannot enforce; recorded, never claimed as enforced. */
  readonly unenforceable: ReadonlyArray<{ readonly aspect: string; readonly reason: string }>;
}

const NO_OS_SANDBOX =
  'Claude Code has no OS sandbox: it bounds what its own tools will do, not what the processes it starts may do. A SessionStart hook launched by the installed 2.1.260 build wrote outside every granted directory, wrote to /tmp, read outside and reached the network (docs/runtime-claude-code.md, "Containment truth"). Kernel-level containment must come from the environment around the process.';

const NETWORK_NOT_ENFORCED =
  'no flag on this build denies worker-tool network access. `--restricted` removes WebFetch from the tool set unless --tools names it, which is a tool-surface reduction, not a network boundary.';

const EXTERNAL_DELIVERY_NOT_ENFORCED =
  'no flag prevents a worker from attempting a push or a deployment; the coordinator denies external delivery by withholding credentials and remotes, not through this adapter.';

export interface PolicyMappingOptions {
  /**
   * Grant `Bash`. Off by default: with a shell the runtime has no write
   * boundary at all, so a `local-development` session that turns this on is
   * no longer contained by the runtime and the adapter says so.
   */
  readonly allowCommandExecution?: boolean;
}

export function mapPolicy(policy: Policy, options: PolicyMappingOptions = {}): PolicyMapping {
  const allowCommands = options.allowCommandExecution === true;
  const unenforceable: Array<{ aspect: string; reason: string }> = [
    { aspect: 'process_containment', reason: NO_OS_SANDBOX },
    { aspect: 'worker_network', reason: NETWORK_NOT_ENFORCED },
    { aspect: 'external_delivery', reason: EXTERNAL_DELIVERY_NOT_ENFORCED },
  ];

  switch (policy) {
    case 'analysis': {
      const tools = allowCommands ? [...READ_TOOLS, ...COMMAND_TOOLS] : [...READ_TOOLS];
      if (allowCommands) {
        unenforceable.push({
          aspect: 'analysis_read_only',
          reason: 'command execution was explicitly granted, so the analysis profile\'s "do not execute repository hooks/tests" rule is no longer enforced by the runtime',
        });
      }
      return { policy, permissionMode: 'plan', tools, restricted: true, writeCandidate: false, unenforceable };
    }
    case 'local-development': {
      const tools = allowCommands ? [...READ_TOOLS, ...WRITE_TOOLS, ...COMMAND_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS];
      if (allowCommands) {
        unenforceable.push({
          aspect: 'write_confinement',
          reason: 'Bash was explicitly granted. `--restricted` confines the *file tools* to the working directories; a shell command is not a file tool, so writes outside the granted candidate are no longer bounded by the runtime.',
        });
      }
      return { policy, permissionMode: 'acceptEdits', tools, restricted: true, writeCandidate: true, unenforceable };
    }
    case 'verification': {
      // The verification profile belongs to the check runner (src/verification),
      // which executes configured commands against a frozen candidate copy. It
      // is not a model session, so this adapter refuses it rather than pretending.
      return {
        policy,
        permissionMode: 'plan',
        tools: [],
        restricted: true,
        writeCandidate: false,
        unenforceable: [
          ...unenforceable,
          {
            aspect: 'verification_profile',
            reason: 'the verification profile runs configured check commands against a frozen candidate copy; it is the check runner\'s job, not a runtime session. This adapter refuses to open a session under it.',
          },
        ],
      };
    }
    default: {
      const never: never = policy;
      throw new Error(`unknown policy ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// What the runtime says it granted (FR042)
// ---------------------------------------------------------------------------

/** One aspect of the requested profile that the runtime says it applied differently. */
export interface ProfileMismatch {
  readonly aspect: string;
  readonly requested: string;
  readonly reported: string;
  readonly detail: string;
}

/**
 * Compare the tool surface and permission mode the runtime says took effect
 * against the ones the profile asked for.
 *
 * This matters more here than the same check would anywhere else. Claude Code
 * has no OS sandbox, so for this runtime the granted tool surface *is* the
 * write boundary — `write_containment` is a claim that `--restricted --tools …`
 * yields exactly the named tools and nothing else. The `init` record states
 * what was actually granted, and until now nothing compared the two: the
 * initialize-time permission-mode check wrote a string into an accessor no
 * caller outside this directory reads, and `#normalizeSystem` then overwrote
 * the very field that check had looked at.
 *
 * An extra tool is the dangerous direction — the boundary is wider than the
 * profile the run claims — but a missing one is reported too, because a
 * profile that silently lost `Edit` explains a worker that could not do its
 * job.
 */
export function compareGrantedSurface(
  mapping: PolicyMapping,
  reported: { readonly permissionMode?: string | null | undefined; readonly tools?: ReadonlyArray<string> | null | undefined },
): ProfileMismatch[] {
  const mismatches: ProfileMismatch[] = [];
  const permissionMode = reported.permissionMode ?? null;
  if (permissionMode !== null && permissionMode !== mapping.permissionMode) {
    mismatches.push({
      aspect: 'permissionMode',
      requested: mapping.permissionMode,
      reported: permissionMode,
      detail: `the "${mapping.policy}" profile asked for permission mode "${mapping.permissionMode}" and the runtime reports it is running under "${permissionMode}"`,
    });
  }
  const tools = reported.tools ?? null;
  if (tools !== null) {
    const requested = new Set(mapping.tools);
    const granted = new Set(tools);
    const extra = [...granted].filter((tool) => !requested.has(tool)).sort();
    const missing = [...requested].filter((tool) => !granted.has(tool)).sort();
    if (extra.length > 0) {
      mismatches.push({
        aspect: 'tools',
        requested: [...mapping.tools].sort().join(', '),
        reported: [...granted].sort().join(', '),
        detail:
          `the runtime granted ${extra.length} tool(s) the "${mapping.policy}" profile did not ask for (${extra.join(', ')}). ` +
          'Claude Code has no OS sandbox, so the granted tool surface is the only write boundary this runtime has: a wider surface than the profile requested is a wider boundary than the run claims',
      });
    }
    if (missing.length > 0) {
      mismatches.push({
        aspect: 'tools',
        requested: [...mapping.tools].sort().join(', '),
        reported: [...granted].sort().join(', '),
        detail: `the runtime did not grant ${missing.length} tool(s) the "${mapping.policy}" profile asked for (${missing.join(', ')})`,
      });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export interface ClaudeArgvInput {
  /** The id the session will have. When resuming without forking it must equal `resume`. */
  readonly sessionId: string;
  readonly policy: Policy;
  readonly mapping: PolicyMapping;
  readonly allowedWritePaths: ReadonlyArray<string>;
  readonly systemInstructions: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly maxBudgetUsd?: number | undefined;
  readonly resume?: string | undefined;
  readonly forkSession?: boolean | undefined;
  readonly includeDeltas?: boolean | undefined;
}

/**
 * Build the argument vector.
 *
 * Two properties of the installed build shape the order, and both were
 * established by running it:
 *
 *  - `--tools <tools...>` and `--add-dir <directories...>` are variadic, and a
 *    variadic option swallows every following bare word — including the
 *    positional prompt. `claude … --tools Read "say hi"` fails with *"Input
 *    must be provided either through stdin or as a prompt argument"* because
 *    `say hi` was consumed as a tool name. This adapter never passes a
 *    positional prompt (the prompt arrives as a stdin frame) and still places a
 *    non-variadic option after every variadic one, so the argv cannot be
 *    misread.
 *
 *  - `--session-id` and `--resume` are mutually exclusive unless
 *    `--fork-session` is given: *"--session-id can only be used with --continue
 *    or --resume if --fork-session is also specified."* A plain resume
 *    therefore passes only `--resume`, and the resumed session keeps the id we
 *    minted when it was first opened. A fork passes all three and takes a new id.
 */
export function buildClaudeArgs(input: ClaudeArgvInput): string[] {
  const args: string[] = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages'];

  // Never inherit the user's MCP servers into a worker session.
  args.push('--strict-mcp-config');
  // Never load the user's, the project's or the local settings file: a
  // registered project's own `.claude/settings.json` SessionStart hook ran in
  // a worker session on this build until this flag was set.
  args.push('--setting-sources', '');

  if (input.mapping.restricted) args.push('--restricted');

  // A variadic option, closed by a non-variadic one.
  args.push('--tools', ...(input.mapping.tools.length > 0 ? input.mapping.tools : ['']));
  args.push('--permission-mode', input.mapping.permissionMode);

  if (input.allowedWritePaths.length > 0) args.push('--add-dir', ...input.allowedWritePaths);
  // "nobody: anything that would prompt is denied automatically" — and it closes the variadic list above.
  args.push('--permission-prompts', 'none');

  if (input.resume === undefined) {
    args.push('--session-id', input.sessionId);
  } else if (input.forkSession === true) {
    args.push('--resume', input.resume, '--fork-session', '--session-id', input.sessionId);
  } else {
    // The resumed conversation keeps its own id; passing --session-id too is refused.
    args.push('--resume', input.resume);
  }

  if (input.model !== undefined) args.push('--model', input.model);
  if (input.effort !== undefined) args.push('--effort', input.effort);
  if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
  if (input.includeDeltas === true) args.push('--include-partial-messages');
  if (input.systemInstructions.trim().length > 0) args.push('--append-system-prompt', input.systemInstructions);
  return args;
}

// ---------------------------------------------------------------------------
// Error classification (plan section 9: classify, never guess a retryable class)
// ---------------------------------------------------------------------------

export type ClaudeErrorClass = 'authentication' | 'usage_limit' | 'provider_transient' | 'budget_exhausted' | 'permission_denied' | 'invalid_request' | 'unknown';

/**
 * Classify a failing result record. The mapping keys off the machine-readable
 * markers the CLI supplies (`error`, `subtype`, `terminal_reason`) and only
 * falls back to text for the two messages actually observed on this build.
 * Anything unrecognised stays `unknown` rather than being guessed into a
 * retryable class.
 */
export function classifyClaudeError(input: {
  readonly error?: string | null | undefined;
  readonly subtype?: string | null | undefined;
  readonly terminalReason?: string | null | undefined;
  readonly message?: string | null | undefined;
}): ClaudeErrorClass {
  const error = input.error ?? '';
  if (error === 'authentication_failed') return 'authentication';
  if (error === 'rate_limit_error' || error === 'usage_limit_reached') return 'usage_limit';
  if (input.subtype === 'error_max_budget' || input.terminalReason === 'max_budget') return 'budget_exhausted';
  if (input.subtype === 'error_max_turns') return 'invalid_request';
  const message = (input.message ?? '').toLowerCase();
  if (message.includes('oauth session expired') || message.includes('failed to authenticate')) return 'authentication';
  if (message.includes('no conversation found with session id')) return 'invalid_request';
  return 'unknown';
}
