/**
 * The local office view server (FR084): `workforce serve`.
 *
 * A loopback-only `node:http` server over the coordinator's recorded state.
 * It serves the workspace UI from `web/workspace`, a read API assembled from the
 * storage functions the CLI uses, a Server-Sent Events tail of the events
 * tables, the workspace routes, and the request queue. It holds no task truth:
 * everything it reports is read back from the state stores, which it opens
 * read-only, and it reaches the engine only by spawning `workforce run` or
 * `workforce resume` with an argument array. It writes `workspace.json`
 * through the workspace operations, and its own queue and launch logs under
 * `<state-root>/serve/`.
 *
 * Routes (every GET is Host/Origin checked; every POST also needs this
 * server's Origin, the session token and a JSON body):
 *   GET  /                                          the office page (session token injected)
 *   GET  /assets/*, /src/*                          the page's own files
 *   GET  /api/office                                legacy v1 agents, passive runtime readiness, coordinator identity
 *
 *   GET  /api/workspace                             the workspace, its revision, readiness, runtime rules, suggested starter
 *   POST /api/workspace/ops                         {expectRevision, ops[]}: workspace operations, compare-and-swap
 *   POST /api/workspace/ops/:op                     {expectRevision, ...fields}: one operation, same path
 *   POST /api/projects/inspect                      {path}: a folder, read with Git only
 *
 *   GET  /api/runs?limit=                           runs across every project (each with projectId), earlier history apart
 *   GET  /api/projects/:id/runs?limit=              one project's runs
 *   GET  /api/projects/:id/runs/:runId              exactly `workforce status <runId> --state-dir <project root> --json`
 *   GET  /api/projects/:id/runs/:runId/events       every event of that run, a page at a time (?after=<sequence>&limit=)
 *   GET  /api/projects/:id/runs/:runId/artifacts/:a one text artifact of that project's run
 *   POST /api/projects/:id/runs/:runId/stop         SIGINT to the tracked pid of a run this server started
 *   POST /api/projects/:id/runs/:runId/resume       {allowUnconfinedWrites?}: `workforce resume` through the queue
 *
 *   GET  /api/requests                              the queue: every item, what is live, the limit
 *   POST /api/requests                              {projectId, departmentId, task, clientRequestId?, allowUnconfinedWrites?}: start or queue; retained submission IDs deduplicate retries
 *   GET  /api/requests/:id                          one item
 *   POST /api/requests/:id/start|discard|stop       {}: start a held item, discard a waiting one, stop a live one
 *
 *   GET  /api/events?after=                         SSE over every project's events (and earlier history); resumable
 *
 *   POST /api/runs, POST /api/runs/preview          legacy single-root start; refused 409 once a workspace exists
 *   GET  /api/runs/:id, /api/runs/:id/events,
 *        /api/runs/:id/artifacts/:a                 earlier history (the root state), read-only
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { nowIso } from '../core/ids.js';
import { discoverWorkspaceRuntimes, readinessReportForRuntime, type RuntimeReadinessReport } from '../discovery/readiness.js';
import { validateAttachments } from '../adapters/attachments.js';
import { ATTACHMENT_LIMITS, storeAttachments } from './attachments.js';
import { listProjectFolders } from './project-folders.js';
import { discoverRuntimeModels } from '../discovery/model-catalog.js';
import { sanitizedProbeEnv } from '../discovery/spawn.js';
import { createStatePaths } from '../storage/paths.js';
import { redactText } from '../telemetry/redaction.js';
import { workspaceFilePath } from '../workspace/paths.js';
import { buildNathanJamesTeamOps } from '../workspace/team-templates.js';
import { isToolUsable } from '../core/workspace-config.js';
import { WorkspaceError } from '../workspace/errors.js';
import { serveEventStream } from './events-stream.js';
import {
  ApiError,
  checkApiRead,
  checkApiWrite,
  checkHost,
  LOOPBACK_HOST,
  originOf,
  readBody,
  sendBody,
  sendError,
  sendJson,
  type Endpoint,
} from './http.js';
import { createLauncher, previewStart, type CliInvocation, type Spawner } from './launch.js';
import { allRunsDocument, projectRunsDocument, readableProjectPaths } from './project-reads.js';
import { artifactDocument, ID_PATTERN, officeDocument, parseLimit, runEventsDocument, runStatusJson } from './read-api.js';
import { EmptyBodySchema, RequestQueue } from './requests.js';
import { IssuesApi } from './issues-api.js';
import { ConnectionsApi, type ConnectionsApiOptions } from './connections-api.js';
import { IssueStore } from '../issues/store.js';
import { defaultWebRoot, injectSessionToken, packageRoot, resolveStaticFile } from './static.js';
import { applySingleWorkspaceOp, applyWorkspaceWrite, inspectFolder, invalidBody, httpErrorFromWorkspace, OP_NAME_PATTERN, readWorkspace, workspaceDocument, type PassiveReadiness } from './workspace-api.js';

export const DEFAULT_SERVE_PORT = 4421;
/** Passive discovery is cheap but not free (it runs `--version` and a login-status command); reuse it for a while. */
export const READINESS_TTL_MS = 5 * 60 * 1000;

export interface OfficeServerOptions {
  readonly stateRoot: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly webRoot?: string;
  /** Passive runtime discovery; never a live check. Replaceable so a test does not probe the machine's runtimes. */
  readonly discover?: () => Promise<ReadonlyArray<RuntimeReadinessReport>>;
  /** Metadata handshake only; replaceable in tests without a machine's CLI. */
  readonly modelCatalog?: typeof discoverRuntimeModels;
  readonly spawner?: Spawner;
  readonly cliInvocation?: CliInvocation;
  readonly launchTimeoutMs?: number;
  readonly pollMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Pass `--state-dir=<stateRoot>` to the `workforce run` a request starts.
   * `workforce serve` sets it only when it was given `--state-dir`; otherwise the
   * run finds the same state root the way the server did. Default true.
   */
  readonly passStateDir?: boolean;
  /** How often the request queue looks at its processes and project locks. */
  readonly queuePollMs?: number;
  /** Isolated connection probes for tests; production discovers installed clients. */
  readonly connections?: Omit<ConnectionsApiOptions, 'stateRoot' | 'serverUrl' | 'env'>;
}

export interface OfficeServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Held in this process and written only into served HTML. */
  readonly token: string;
  readonly stateRoot: string;
  readonly webRoot: string;
  close(): Promise<void>;
}

function packageVersion(): string {
  try {
    const parsed = z.object({ version: z.string() }).safeParse(JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')));
    return parsed.success ? parsed.data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'the request body is not valid JSON');
  }
}

/** A body that may be empty: the action routes take `{}` or nothing. */
function parseEmptyBody(text: string): void {
  const parsed = EmptyBodySchema.safeParse(text.trim().length === 0 ? {} : parseJson(text));
  if (!parsed.success) throw invalidBody(parsed.error.issues, 'the request');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendError(res, new ApiError(405, 'method_not_allowed', `this route accepts ${allow}`), { Allow: allow });
}

interface Route {
  readonly allow: string;
  readonly handle: (method: string, url: URL) => Promise<void> | void;
}

export async function startOfficeServer(options: OfficeServerOptions): Promise<OfficeServer> {
  const token = randomBytes(32).toString('hex');
  const paths = createStatePaths(options.stateRoot);
  const root = paths.root;
  const webRoot = path.resolve(options.webRoot ?? defaultWebRoot());
  const env = options.env ?? process.env;
  const version = packageVersion();
  const startedAt = nowIso();
  const streams = new Set<ServerResponse>();
  const launcher = createLauncher({
    paths,
    env,
    ...(options.spawner !== undefined ? { spawner: options.spawner } : {}),
    ...(options.cliInvocation !== undefined ? { invocation: options.cliInvocation } : {}),
    ...(options.launchTimeoutMs !== undefined ? { timeoutMs: options.launchTimeoutMs } : {}),
  });

  let readiness: { at: number; bindings: string; value: Promise<PassiveReadiness> } | null = null;
  const currentReadiness = (refresh: boolean): Promise<PassiveReadiness> => {
    const runtimes = readWorkspace(root).loaded?.config.runtimes ?? {};
    const bindings = JSON.stringify(runtimes);
    if (readiness === null || refresh || readiness.bindings !== bindings || Date.now() - readiness.at > READINESS_TTL_MS) {
      readiness = {
        at: Date.now(),
        bindings,
        value: (options.discover?.() ?? discoverWorkspaceRuntimes(runtimes, {
          pathValue: env['PATH'] ?? '', env: sanitizedProbeEnv(env),
          ...(env['HOME'] !== undefined ? { homeDir: env['HOME'] } : {}),
        })).then(
          (reports) => ({ checkedAt: nowIso(), reports }),
          (error: unknown) => ({ error: `passive runtime discovery failed: ${(error as Error).message}` }),
        ),
      };
    }
    return readiness.value;
  };

  const catalogs = new Map<string, { key: string; at: number; pending: boolean; value: ReturnType<typeof discoverRuntimeModels> }>();
  const runtimeModels = async (runtimeId: string, refresh = false) => {
    const runtime = readWorkspace(root).loaded?.config.runtimes[runtimeId];
    if (!runtime) throw new ApiError(404, 'unknown_runtime', 'This runtime is not configured in the workspace.');
    const observed = await currentReadiness(refresh);
    const reports = 'reports' in observed ? observed.reports : [];
    const key = JSON.stringify([runtime, reports.filter((report) => report.runtimeId === runtimeId || !report.runtimeId && report.adapter === runtime.adapter).map((report) => [report.executable, report.realPath, report.version, report.auth])]);
    const cached = catalogs.get(runtimeId);
    if (cached && cached.key === key && (cached.pending || !refresh && Date.now() - cached.at < READINESS_TTL_MS)) return cached.value;
    const entry = { key, at: Date.now(), pending: true, value: (options.modelCatalog ?? discoverRuntimeModels)({ runtimeId, runtime, reports }) };
    catalogs.set(runtimeId, entry);
    try { return await entry.value; } catch (error) {
      if (catalogs.get(runtimeId) === entry) catalogs.delete(runtimeId);
      throw error;
    } finally { entry.pending = false; }
  };

  const issueRecords = new IssueStore(root);
  const queue = new RequestQueue({
    stateRoot: root,
    passStateDir: options.passStateDir ?? true,
    env,
    readiness: () => currentReadiness(false),
    onPersist: records => issueRecords.recordRequests(records),
    validateControl: async (settings, runtime, _reports, attachments = []) => {
      if (runtime.adapter === 'fake' || settings.model === undefined && settings.effort === undefined && attachments.length === 0) return;
      const catalog = await runtimeModels(settings.runtime);
      if (catalog.status !== 'available') throw new ApiError(409, 'control_models_unavailable', 'Control Center model choices could not be read from this runtime. Refresh its models or use runtime defaults.', catalog.diagnostics);
      const model = catalog.models.find((item) => item.id === (settings.model ?? catalog.defaultModel));
      if (settings.model !== undefined && !model) throw new ApiError(400, 'unsupported_control_model', `The installed runtime does not offer model "${settings.model}". Select a model from its current list.`);
      if (settings.effort !== undefined && (!model || !model.efforts.includes(settings.effort))) throw new ApiError(400, 'unsupported_control_effort', 'The selected model does not report support for that reasoning effort. Select one of its offered levels or use the runtime default.');
      if (attachments.length) {
        try { validateAttachments(runtime.adapter, attachments, model?.inputModalities ? { inputModalities: model.inputModalities } : {}); }
        catch (error) { throw new ApiError(400, 'unsupported_attachment', error instanceof Error ? error.message : 'This model cannot read an attached file.'); }
      }
    },
    ...(options.spawner !== undefined ? { spawner: options.spawner } : {}),
    ...(options.cliInvocation !== undefined ? { invocation: options.cliInvocation } : {}),
    ...(options.queuePollMs !== undefined ? { pollMs: options.queuePollMs } : {}),
  });
  const writeContext = { stateRoot: root, projectBusy: (projectId: string) => queue.projectBusy(projectId) };
  const issues = new IssuesApi(root, queue);
  const workspaceConfig = () => readWorkspace(root).loaded?.config ?? null;
  const refuseLegacyStartWithWorkspace = (): void => {
    if (existsSync(workspaceFilePath(root))) {
      throw new ApiError(
        409,
        'workspace_exists',
        'this state root has a workspace, so work goes to a department: POST /api/requests. A run is never started here without a department, its head and its roster',
        [`workspace: ${workspaceFilePath(root)}`],
      );
    }
  };

  let endpoint: Endpoint = { host: LOOPBACK_HOST, port: options.port };
  const connections = new ConnectionsApi({ ...options.connections, stateRoot: root, serverUrl: () => originOf(endpoint), env,
    onAuthenticationChanged: () => {
      readiness = null;
      catalogs.clear();
      options.connections?.onAuthenticationChanged?.();
    },
  });

  function matchRoute(req: IncomingMessage, res: ServerResponse, segments: ReadonlyArray<string>): Route | null {
    const [a, b, c, d, e, f] = segments;
    const n = segments.length;
    const body = async () => parseJson(await readBody(req));
    const emptyBody = async () => parseEmptyBody(await readBody(req));

    if (a === 'office' && n === 1) {
      return {
        allow: 'GET',
        handle: async (_method, url) =>
          sendJson(
            res,
            200,
            officeDocument({ paths, version, env, server: { pid: process.pid, startedAt, url: `${originOf(endpoint)}/`, packageRoot: packageRoot() }, readiness: await currentReadiness(url.searchParams.get('refresh') === '1') }),
          ),
      };
    }

    // ---- workspace ----------------------------------------------------------
    if (a === 'connections' && n === 1) {
      return { allow: 'GET', handle: async (_method, url) => sendJson(res, 200, await connections.list(url.searchParams.get('refresh') === '1')) };
    }
    if (a === 'connections' && b && (c === 'connect' || c === 'verify') && n === 3) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await connections.action(b, c, await body())) };
    }
    if (a === 'connections' && b && c === 'auth' && n === 3) {
      return { allow: 'GET', handle: async () => sendJson(res, 200, await connections.authenticationStatus(b)) };
    }
    if (a === 'connections' && b && (c === 'sign-in' || c === 'cancel-sign-in') && n === 3) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await connections.authenticationAction(b, c, await body())) };
    }
    if (a === 'runtimes' && b && c === 'models' && n === 3) {
      return { allow: 'GET', handle: async (_method, url) => sendJson(res, 200, await runtimeModels(b, url.searchParams.get('refresh') === '1')) };
    }
    if (a === 'workspace' && n === 1) {
      return { allow: 'GET', handle: async (_method, url) => sendJson(res, 200, await workspaceDocument(root, await currentReadiness(url.searchParams.get('refresh') === '1'))) };
    }
    if (a === 'workspace' && b === 'templates' && c === 'nathan-james' && n === 3) {
      return { allow: 'GET', handle: async () => {
        const observed = await currentReadiness(false);
        const loaded = readWorkspace(root);
        if (loaded.error) throw new ApiError(409, loaded.error.code, loaded.error.message, loaded.error.details);
        const config = loaded.loaded?.exists ? loaded.loaded.config : null;
        if (!config) throw new ApiError(409, 'workspace_required', 'Create your workspace before setting up a team.');
        try {
          const reports = 'reports' in observed ? observed.reports : [];
          const runtimeReports = Object.entries(config.runtimes).map(([runtimeId, runtime]) => {
            const report = readinessReportForRuntime(reports, runtimeId, runtime);
            return { runtimeId, usable: !!report && isToolUsable(report), ...(report ? { auth: report.auth } : {}) };
          });
          const plan = buildNathanJamesTeamOps(config, { runtimeReports });
          sendJson(res, 200, { ok: true, ...plan, revision: plan.expectRevision });
        } catch (error) {
          if (error instanceof WorkspaceError) throw httpErrorFromWorkspace(error);
          throw error;
        }
      } };
    }
    if (a === 'workspace' && b === 'ops' && n === 2) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await applyWorkspaceWrite(await body(), writeContext)) };
    }
    if (a === 'workspace' && b === 'ops' && n === 3 && OP_NAME_PATTERN.test(c!)) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await applySingleWorkspaceOp(c!, await body(), writeContext)) };
    }
    if (a === 'attachments' && n === 1) {
      return { allow: 'POST', handle: async () => sendJson(res, 201, await storeAttachments(root, parseJson(await readBody(req, ATTACHMENT_LIMITS.maxBodyBytes)))) };
    }
    if (a === 'projects' && b === 'folders' && n === 2) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await listProjectFolders(await body(), root)) };
    }
    if (a === 'projects' && b === 'inspect' && n === 2) {
      return { allow: 'POST', handle: async () => sendJson(res, 200, await inspectFolder(await body(), root)) };
    }

    // ---- one project's runs --------------------------------------------------
    if (a === 'projects' && b !== undefined && b !== 'inspect' && c === 'runs') {
      if (n === 3) return { allow: 'GET', handle: (_method, url) => sendJson(res, 200, projectRunsDocument(root, b, workspaceConfig(), parseLimit(url.searchParams.get('limit')))) };
      if (n === 4 && ID_PATTERN.test(d!)) {
        return { allow: 'GET', handle: () => sendBody(res, 200, 'application/json; charset=utf-8', runStatusJson(readableProjectPaths(root, b, workspaceConfig()).root, d!)) };
      }
      if (n === 5 && ID_PATTERN.test(d!) && e === 'stop') {
        return {
          allow: 'POST',
          handle: async () => {
            await emptyBody();
            readableProjectPaths(root, b, workspaceConfig());
            sendJson(res, 202, { ok: true, request: queue.stopRun(b, d!) });
          },
        };
      }
      if (n === 5 && ID_PATTERN.test(d!) && e === 'resume') {
        return {
          allow: 'POST',
          handle: async () => {
            const text = await readBody(req);
            sendJson(res, 202, { ok: true, request: await queue.resume(b, d!, text.trim().length === 0 ? {} : parseJson(text)) });
          },
        };
      }
      if (n === 5 && ID_PATTERN.test(d!) && e === 'events') {
        return { allow: 'GET', handle: (_method, url) => sendJson(res, 200, runEventsDocument(readableProjectPaths(root, b, workspaceConfig()), d!, url.searchParams)) };
      }
      if (n === 6 && ID_PATTERN.test(d!) && e === 'artifacts' && ID_PATTERN.test(f!)) {
        return { allow: 'GET', handle: () => sendJson(res, 200, artifactDocument(readableProjectPaths(root, b, workspaceConfig()), d!, f!)) };
      }
    }

    // ---- project issue board: metadata and ordinary Control Center submissions --
    if (a === 'issues' && n === 1) {
      return { allow: 'GET, POST', handle: async (method, url) => {
        if (method === 'GET') return sendJson(res, 200, issues.list(url.searchParams.get('projectId') ?? undefined, url.searchParams));
        sendJson(res, 201, await issues.create(await body()));
      } };
    }
    if (a === 'issues' && n === 2 && ID_PATTERN.test(b!)) {
      return { allow: 'GET', handle: () => sendJson(res, 200, issues.get(b!)) };
    }
    if (a === 'issues' && n === 3 && ID_PATTERN.test(b!) && (c === 'update' || c === 'start')) {
      return { allow: 'POST', handle: async () => {
        const input = await body();
        sendJson(res, c === 'start' ? 202 : 200, c === 'start' ? await issues.start(b!, input) : issues.update(b!, input));
      } };
    }

    // ---- the request queue -----------------------------------------------------
    if (a === 'requests' && n === 1) {
      return {
        allow: 'GET, POST',
        handle: async (method) => {
          if (method === 'GET') return sendJson(res, 200, queue.list());
          const item = await queue.submit(await body());
          sendJson(res, 202, { ok: true, started: item.state === 'starting' || item.state === 'running', request: item, statusPath: `/api/requests/${item.id}` });
        },
      };
    }
    if (a === 'requests' && n === 2 && ID_PATTERN.test(b!)) return { allow: 'GET', handle: () => sendJson(res, 200, { ok: true, request: queue.get(b!) }) };
    if (a === 'requests' && n === 3 && ID_PATTERN.test(b!) && c === 'retry') {
      return { allow: 'POST', handle: async () => {
        const item = await queue.retry(b!, await body());
        sendJson(res, 202, { ok: true, request: item, statusPath: `/api/requests/${item.id}` });
      } };
    }
    if (a === 'requests' && n === 3 && ID_PATTERN.test(b!) && (c === 'start' || c === 'discard' || c === 'stop')) {
      return {
        allow: 'POST',
        handle: async () => {
          await emptyBody();
          const item = c === 'start' ? queue.start(b!) : c === 'discard' ? queue.discard(b!) : queue.stop(b!);
          sendJson(res, 200, { ok: true, request: item });
        },
      };
    }

    // ---- runs: the list across projects, and the legacy single-root routes -----
    // Before the run-id route: "preview" is not a run id, and it needs the
    // start route's proofs (it runs git in the named directory).
    if (a === 'runs' && b === 'preview' && n === 2) {
      return {
        allow: 'POST',
        handle: async () => {
          refuseLegacyStartWithWorkspace();
          const input = await body();
          const readinessNow = await currentReadiness(false);
          sendJson(res, 200, await previewStart(input, { paths, env, reports: 'reports' in readinessNow ? readinessNow.reports : [] }));
        },
      };
    }
    if (a === 'runs' && n === 1) {
      return {
        allow: 'GET, POST',
        handle: async (method, url) => {
          if (method === 'GET') return sendJson(res, 200, allRunsDocument(root, workspaceConfig(), parseLimit(url.searchParams.get('limit'))));
          refuseLegacyStartWithWorkspace();
          const started = await launcher.start(await body());
          sendJson(res, 201, {
            ok: true,
            runId: started.runId,
            launchId: started.launchId,
            pid: started.pid,
            statusPath: `/api/runs/${started.runId}`,
            note: 'the run belongs to its own workforce run process: stopping this server does not stop it, and interrupting that pid (SIGINT) stops it the way Ctrl+C would',
          });
        },
      };
    }
    if (a === 'runs' && n === 2 && ID_PATTERN.test(b!)) return { allow: 'GET', handle: () => sendBody(res, 200, 'application/json; charset=utf-8', runStatusJson(root, b!)) };
    if (a === 'runs' && n === 3 && ID_PATTERN.test(b!) && c === 'events') return { allow: 'GET', handle: (_method, url) => sendJson(res, 200, runEventsDocument(paths, b!, url.searchParams)) };
    if (a === 'runs' && n === 4 && ID_PATTERN.test(b!) && c === 'artifacts' && ID_PATTERN.test(d!)) {
      return { allow: 'GET', handle: () => sendJson(res, 200, artifactDocument(paths, b!, d!)) };
    }

    if (a === 'events' && n === 1) {
      return {
        allow: 'GET',
        handle: (_method, url) =>
          serveEventStream(req, res, url.searchParams, { stateRoot: root, ...(options.pollMs !== undefined ? { pollMs: options.pollMs, idlePollMs: options.pollMs } : {}) }, streams),
      };
    }
    return null;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
    const url = new URL(target, originOf(endpoint));
    const segments = url.pathname.split('/').slice(2);
    const method = req.method ?? 'GET';
    const route = matchRoute(req, res, segments);

    const gate = method === 'GET' || method === 'HEAD' ? checkApiRead(req, endpoint) : method === 'POST' ? checkApiWrite(req, endpoint, token) : null;
    if (gate === null) return methodNotAllowed(res, route?.allow ?? 'GET');
    if (!gate.ok) return sendError(res, gate.error);
    if (route === null) throw new ApiError(404, 'not_found', 'no such route');
    if (!route.allow.split(', ').includes(method)) return methodNotAllowed(res, route.allow);
    return route.handle(method, url);
  }

  function handleStatic(req: IncomingMessage, res: ServerResponse, target: string): void {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    const resolved = resolveStaticFile(webRoot, target);
    if (!resolved.ok) {
      return sendBody(res, resolved.status, 'text/plain; charset=utf-8', resolved.status === 404 ? 'Not found\n' : 'Bad request\n', {}, method === 'HEAD');
    }
    const bytes = readFileSync(resolved.file);
    const staticPrefix = target.startsWith('/workspace') ? '/workspace' : target.startsWith('/office') ? '/office' : '';
    const html = staticPrefix ? bytes.toString('utf8').replaceAll('href="/src/', `href="${staticPrefix}/src/`).replaceAll('src="/src/', `src="${staticPrefix}/src/`) : bytes.toString('utf8');
    const body = resolved.contentType.startsWith('text/html') ? injectSessionToken(html, token) : bytes;
    sendBody(res, 200, resolved.contentType, body, {}, method === 'HEAD');
  }

  const server = createServer((req, res) => {
    const respond = async (): Promise<void> => {
      const host = checkHost(req, endpoint);
      if (!host.ok) return sendError(res, host.error);
      const target = req.url ?? '/';
      const pathname = target.split('?', 1)[0]!;
      if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, target);
      return handleStatic(req, res, target);
    };
    respond().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ApiError) return sendError(res, error);
      sendError(res, new ApiError(500, 'internal_error', redactText((error as Error).message ?? String(error))));
    });
  });

  try {
    await listen(server, options.port);
  } catch (error) {
    queue.close();
    await connections.close();
    throw error;
  }
  endpoint = { host: LOOPBACK_HOST, port: (server.address() as AddressInfo).port };

  return {
    url: `${originOf(endpoint)}/`,
    host: endpoint.host,
    port: endpoint.port,
    token,
    stateRoot: root,
    webRoot,
    close: async () => {
      await connections.close();
      await new Promise<void>((resolve) => {
        queue.close();
        for (const stream of streams) stream.end();
        streams.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
