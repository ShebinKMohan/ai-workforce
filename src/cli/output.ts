/**
 * CLI output and exit codes.
 *
 * Human mode: results on stdout, diagnostics on stderr.
 * JSON mode (--json): exactly one JSON document on stdout; every human line
 * goes to stderr so stdout stays machine-readable. All output is redacted.
 */
import { redactText, redactedJson } from '../telemetry/redaction.js';
import { sanitizeRow } from './ansi.js';

/** Frozen once CLI tests exist (AGENTS.md). */
export const EXIT_CODES = {
  verifiedCandidate: 0,
  invalidInput: 2,
  userActionRequired: 3,
  executionFailure: 4,
  interrupted: 130,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details: ReadonlyArray<string>;

  constructor(exitCode: ExitCode, code: string, message: string, details: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export interface CommandResult {
  readonly command: string;
  readonly exitCode: ExitCode;
  readonly data: Record<string, unknown>;
  /** Human-readable lines describing `data`. */
  readonly lines: ReadonlyArray<string>;
}

export interface Streams {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/**
 * The last thing that happens to a human line: redact, then drop every escape
 * that is not this program's own colour.
 *
 * A run's lines carry text nobody here composed — a model's sentence, a check
 * command's stderr, a path from a repository — and any of it can contain a
 * cursor sequence. Renderers strip at ingest, which is where it belongs; this
 * is the backstop for every line that reaches a terminal by some other route,
 * such as a `CommandResult` assembled from verifier receipts.
 */
function safe(message: string): string {
  // Sanitised per physical line, so a deliberately multi-line message — an
  // invalid contract listing its issues, a rejected plan listing its codes —
  // keeps the shape it was written in. Only control characters go.
  return redactText(message).split('\n').map(sanitizeRow).join('\n');
}

export class Reporter {
  readonly #json: boolean;
  readonly #streams: Streams;

  constructor(json: boolean, streams: Streams = process) {
    this.#json = json;
    this.#streams = streams;
  }

  get json(): boolean {
    return this.#json;
  }

  /** Diagnostic line: stderr in every mode. */
  diagnostic(message: string): void {
    this.#streams.stderr.write(`${safe(message)}\n`);
  }

  /** Progress/informational line: stdout for humans, stderr in JSON mode. */
  info(message: string): void {
    (this.#json ? this.#streams.stderr : this.#streams.stdout).write(`${safe(message)}\n`);
  }

  result(result: CommandResult): ExitCode {
    if (this.#json) {
      this.#streams.stdout.write(`${redactedJson({ ok: result.exitCode === 0, command: result.command, exitCode: result.exitCode, ...result.data })}\n`);
    } else {
      for (const line of result.lines) this.#streams.stdout.write(`${safe(line)}\n`);
    }
    return result.exitCode;
  }

  failure(command: string, error: CliError): ExitCode {
    if (this.#json) {
      this.#streams.stdout.write(
        `${redactedJson({ ok: false, command, exitCode: error.exitCode, error: { code: error.code, message: error.message, details: error.details } })}\n`,
      );
    }
    this.diagnostic(`error: ${error.message}`);
    for (const detail of error.details) this.diagnostic(`  ${detail}`);
    return error.exitCode;
  }
}

/**
 * One label per criterion status. `COMP` is a criterion whose check passed but
 * whose fixtures the candidate changed: it is neither a pass nor an ordinary
 * failure, and calling it either would be misleading.
 */
export function statusLabel(status: string): string {
  switch (status) {
    case 'passed':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'compromised':
      return 'COMP';
    case 'no_evidence':
      return 'NONE';
    default:
      return '????';
  }
}
