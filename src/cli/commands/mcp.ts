import type { Readable } from 'node:stream';
import { runMcpServer } from '../../mcp/server.js';
import { McpConnectionError } from '../../mcp/client.js';
import { CliError, EXIT_CODES, type ExitCode } from '../output.js';

export async function commandMcp(args: { readonly serverUrl?: string; readonly positionals: ReadonlyArray<string>; readonly json: boolean }, deps: { readonly input: Readable; readonly output: NodeJS.WritableStream; readonly signal?: AbortSignal }): Promise<ExitCode> {
  if (args.positionals.length || args.json) throw new CliError(EXIT_CODES.invalidInput, 'invalid_arguments', 'workforce mcp accepts only --server-url; stdout already uses the MCP protocol.');
  try {
    await runMcpServer({ ...deps, ...(args.serverUrl !== undefined ? { serverUrl: args.serverUrl } : {}) });
  } catch (error) {
    if (error instanceof McpConnectionError) throw new CliError(EXIT_CODES.invalidInput, error.code, error.message);
    throw error;
  }
  return deps.signal?.aborted ? EXIT_CODES.interrupted : EXIT_CODES.verifiedCandidate;
}
