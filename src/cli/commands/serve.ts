/**
 * `workforce serve [--port <n>] [--state-dir <dir>] [--open]` — the local
 * office view (FR084).
 *
 * Serves the vendored office UI and a read API over this state root on
 * 127.0.0.1 only, until Ctrl+C. It takes no coordinator lock and opens the
 * database read-only; the one thing it can start is a run, and it starts it
 * by executing `workforce run --json`, which takes the lock itself.
 *
 * Exit codes: 0 once the server has been stopped, 2 for an invalid `--port`,
 * 4 when the server cannot listen (the port is taken, for one).
 */
import { spawn } from 'node:child_process';
import { resolveStateRoot } from '../../storage/paths.js';
import { DEFAULT_SERVE_PORT, startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../server/index.js';
import { CliError, EXIT_CODES, type CommandResult, type Reporter } from '../output.js';

export interface ServeCommandArgs {
  readonly port?: string;
  readonly stateDir?: string;
  readonly open: boolean;
  readonly json: boolean;
}

export interface ServeCommandDeps {
  readonly reporter: Reporter;
  /** Aborted by Ctrl+C in the CLI; the server runs until then. */
  readonly signal?: AbortSignal;
  readonly start?: (options: OfficeServerOptions) => Promise<OfficeServer>;
  readonly openUrl?: (url: string) => void;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SERVE_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_port', `--port must be an integer from 0 to 65535, not "${value}"`);
  }
  return Number(value);
}

/** The platform's own "open this URL" program, as an argument array. */
export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

function openInBrowser(url: string, reporter: Reporter): void {
  const { command, args } = browserOpenCommand(url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', (error) => reporter.diagnostic(`could not open a browser (${error.message}); open ${url} yourself`));
    child.unref();
  } catch (error) {
    reporter.diagnostic(`could not open a browser (${(error as Error).message}); open ${url} yourself`);
  }
}

export async function commandServe(args: ServeCommandArgs, deps: ServeCommandDeps): Promise<CommandResult> {
  const port = parsePort(args.port);
  const stateRoot = resolveStateRoot(args.stateDir);
  const start = deps.start ?? startOfficeServer;

  let server: OfficeServer;
  try {
    // A run the page starts is given --state-dir only when serve was: otherwise
    // it finds the same state root the same way ($WORKFORCE_STATE_DIR, then ~/.workforce).
    server = await start({ stateRoot, port, passStateDir: args.stateDir !== undefined });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new CliError(EXIT_CODES.executionFailure, 'port_in_use', `127.0.0.1:${port} is already in use`, ['pass --port <n> for another port, or --port 0 for any free one']);
    }
    throw new CliError(EXIT_CODES.executionFailure, 'serve_failed', `could not start the office server: ${(error as Error).message}`);
  }

  deps.reporter.info(`workforce office: ${server.url}`);
  deps.reporter.info(`  state root ${server.stateRoot} (databases read-only; the page writes workspace.json when you change the workspace, and its request queue and launch logs under serve/); bound to 127.0.0.1 only`);
  deps.reporter.info('  sending a request from the page runs `workforce run` and spends model turns; a started run keeps going if this server stops, and a request still waiting is held until you start it again');
  deps.reporter.info('  Ctrl+C stops the server');
  if (args.open) (deps.openUrl ?? ((url: string) => openInBrowser(url, deps.reporter)))(server.url);

  await new Promise<void>((resolve) => {
    if (deps.signal === undefined) return;
    if (deps.signal.aborted) return resolve();
    deps.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.close();

  return {
    command: 'serve',
    exitCode: EXIT_CODES.verifiedCandidate,
    data: { url: server.url, stateRoot: server.stateRoot, stopped: true },
    lines: [`office server at ${server.url} stopped`],
  };
}
