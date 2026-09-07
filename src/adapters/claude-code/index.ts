/**
 * Claude Code adapter (WP05, FR004).
 *
 * `adapter.ts` implements the `RuntimeAdapter` contract over the installed
 * CLI's documented programmatic mode; `transport.ts` owns the process, the
 * newline-delimited framing and the control channel; `protocol.ts` models the
 * records, the argv and the policy mapping. docs/runtime-claude-code.md records
 * what was executed against claude 2.1.260 on macOS and what was not.
 */
export {
  ClaudeCodeAdapter,
  CLAUDE_CODE_ADAPTER,
  CLAUDE_CODE_CAPABILITIES,
  DEFAULT_CLAUDE_EXECUTABLE,
  TESTED_CLAUDE_VERSION,
  UNDISCOVERED_CLAUDE_SETTINGS,
  readUsage,
  type ClaudeCodeAdapterOptions,
  type ClaudeEffectiveSettings,
  type ClaudeTurnUsage,
} from './adapter.js';
export {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  COMMAND_TOOLS,
  FILE_MUTATING_TOOLS,
  READ_TOOLS,
  REFUSED_PERMISSION_MODE,
  WRITE_TOOLS,
  buildClaudeArgs,
  classifyClaudeError,
  decodeStreamLine,
  mapPolicy,
  parseClaudeVersion,
  userFrame,
  controlRequestFrame,
  CONTROL_SUBTYPE,
  type ClaudeErrorClass,
  type DecodedLine,
  type PolicyMapping,
} from './protocol.js';
export { ClaudeTransport, ClaudeTransportError, type RawRecord as ClaudeRawRecord, type StreamRecord as ClaudeStreamRecord } from './transport.js';
