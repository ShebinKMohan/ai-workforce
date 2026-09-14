/** External MCP tools, using the repository's newline-delimited stdio convention. */
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { McpConnectionError, OfficeClient, type OfficeClientOptions } from './client.js';
import { callWorkforceTool, InvalidToolArguments, MCP_TOOLS } from './tools.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_MCP_LINE_BYTES = 512 * 1024;
const Request = z.looseObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(), method: z.string(), params: z.unknown().optional() });
const Initialize = z.looseObject({ protocolVersion: z.string(), capabilities: z.record(z.string(), z.unknown()), clientInfo: z.looseObject({ name: z.string(), version: z.string() }) });
const ToolCall = z.looseObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) });

export interface McpServerOptions extends OfficeClientOptions {
  readonly input: Readable;
  readonly output: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const client = new OfficeClient(options);
  let initialized = false;
  let ready = false;
  const write = (frame: unknown): void => { options.output.write(`${JSON.stringify(frame)}\n`); };
  const error = (id: string | number | null, code: number, message: string): void => write({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id: string | number, value: unknown): void => write({ jsonrpc: '2.0', id, result: value });

  const handle = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); return; }
    const request = Request.safeParse(raw);
    if (!request.success) { error(null, -32600, 'Expected one JSON-RPC request or notification'); return; }
    const { id, method, params } = request.data;
    // Notifications never invoke tools or receive responses. This includes a
    // tools/call-shaped notification: no request identity means no mutation.
    if (id === undefined) {
      if (method === 'notifications/initialized' && initialized) ready = true;
      return;
    }
    if (method === 'ping') { result(id, {}); return; }
    if (method === 'initialize') {
      const parsed = Initialize.safeParse(params);
      if (!parsed.success) { error(id, -32602, 'initialize requires protocolVersion, capabilities and clientInfo'); return; }
      if (initialized) { error(id, -32600, 'This connection is already initialized'); return; }
      initialized = true;
      result(id, {
        protocolVersion: VERSIONS.includes(parsed.data.protocolVersion) ? parsed.data.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-workforce', title: 'AI Workforce', version: '1.0.0' },
        instructions: 'Manage project issues and submit complete plans or PRDs to AI Workforce. List projects first. Preserve original requirements in description. Save without execution by default; use start:true only when the user requested execution. Mutations require a stable idempotencyKey, reused with unchanged arguments after uncertain failures. Control Center routes every started issue through the existing department, head, worker and verification pipeline. A receipt or manual Done status is not verified completion. Tool discovery never starts the workspace server or a paid model turn.',
      });
      return;
    }
    if (!ready) { error(id, -32002, 'Initialize this connection and send notifications/initialized first'); return; }
    if (method === 'tools/list') { result(id, { tools: MCP_TOOLS }); return; }
    if (method !== 'tools/call') { error(id, -32601, `Unknown method: ${method}`); return; }
    const call = ToolCall.safeParse(params);
    if (!call.success) { error(id, -32602, 'tools/call requires name and arguments'); return; }
    try {
      const data = await callWorkforceTool(client, call.data.name, call.data.arguments);
      // A saved issue can outlive a refused start. Preserve its receipt so a
      // caller can inspect it, while clearly reporting the requested failure.
      const startFailed = data['startError'] !== undefined && data['startError'] !== null;
      result(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: startFailed });
    } catch (cause) {
      if (cause instanceof InvalidToolArguments) { error(id, -32602, cause.message); return; }
      const data = cause instanceof McpConnectionError
        ? { error: { code: cause.code, message: cause.message, ...(cause.details !== undefined ? { details: cause.details } : {}) } }
        : { error: { code: 'bridge_failed', message: 'The MCP bridge could not complete this request. Check the local server, then retry mutations with the same idempotencyKey.' } };
      result(id, { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true });
    }
  };

  // Stream incrementally with a hard bound, rather than readline buffering an
  // unbounded unterminated line. Await each call to keep admission ordered and
  // stdin backpressure effective. EOF drains complete requests then exits.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  const consume = async (chunk: string): Promise<void> => {
    const pieces = chunk.split('\n');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      if (!dropping) {
        pending += piece;
        if (Buffer.byteLength(pending, 'utf8') > MAX_MCP_LINE_BYTES) {
          pending = '';
          dropping = true;
          error(null, -32600, 'Request line exceeded 512 KiB');
        }
      }
      if (i < pieces.length - 1) {
        if (!dropping) await handle(pending);
        pending = '';
        dropping = false;
      }
    }
  };
  const stop = (): void => { options.input.destroy(); };
  if (options.signal?.aborted) return;
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of options.input) await consume(typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer));
    await consume(decoder.end());
    if (!dropping && pending.trim()) await handle(pending);
  } catch (cause) {
    if (!options.signal?.aborted) throw cause;
  } finally {
    options.signal?.removeEventListener('abort', stop);
  }
}
