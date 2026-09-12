/**
 * The one error every workspace operation throws.
 *
 * It carries the exit code it means, so the CLI and the server say the same
 * thing about the same refusal: 2 invalid input, 3 the user must act (a
 * revision conflict, an item in use), 4 an execution failure (a writer holds
 * the file lock).
 */
export type WorkspaceExitCode = 2 | 3 | 4;

export class WorkspaceError extends Error {
  readonly exitCode: WorkspaceExitCode;
  readonly code: string;
  readonly details: ReadonlyArray<string>;

  constructor(exitCode: WorkspaceExitCode, code: string, message: string, details: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'WorkspaceError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export function invalidWorkspaceInput(code: string, message: string, details: ReadonlyArray<string> = []): WorkspaceError {
  return new WorkspaceError(2, code, message, details);
}
