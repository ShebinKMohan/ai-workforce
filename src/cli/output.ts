/**
 * CLI output and exit codes.
 *
 * Human mode: results on stdout, diagnostics on stderr.
 * JSON mode (--json): exactly one JSON document on stdout; every human line
 * goes to stderr so stdout stays machine-readable. All output is redacted.
 */
import { redactText, redactedJson } from '../telemetry/redaction.js';

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
    this.#streams.stderr.write(`${redactText(message)}\n`);
  }

  /** Progress/informational line: stdout for humans, stderr in JSON mode. */
  info(message: string): void {
    (this.#json ? this.#streams.stderr : this.#streams.stdout).write(`${redactText(message)}\n`);
  }

  result(result: CommandResult): ExitCode {
    if (this.#json) {
      this.#streams.stdout.write(`${redactedJson({ ok: result.exitCode === 0, command: result.command, exitCode: result.exitCode, ...result.data })}\n`);
    } else {
      for (const line of result.lines) this.#streams.stdout.write(`${redactText(line)}\n`);
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
