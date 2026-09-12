/**
 * Recognising the workforce coordination bridge in a Codex session's own
 * configuration (FR033 support for FR003).
 *
 * Codex 0.147.0 gates every MCP tool call behind an approval request, so the
 * adapter has to be able to answer "is this the coordination bridge I was
 * configured with?" without guessing. It answers from the only trustworthy
 * source available at that point: the `-c mcp_servers.<name>....` overrides
 * the coordinator spliced into this session's argv (`coordinationArgsFor`).
 *
 * The match is deliberately narrow. A server counts as the bridge only when
 * its configured argument vector is exactly `[<this build's bridge entry>]`,
 * which is a path inside the coordinator's own installation. A repository, a
 * model, or a stray `~/.codex/config.toml` entry that merely calls itself
 * "workforce" does not match, and nothing it asks for is approved.
 */
import path from 'node:path';
import { ALL_BRIDGE_TOOL_NAMES, bridgeEntryPath } from '../../coordination/bridge.js';
import type { ProvisionedBridge } from './rpc.js';

/** `mcp_servers.<name>.args=<toml>` — the override that names the server's argument vector. */
const MCP_SERVER_ARGS_OVERRIDE = /^mcp_servers\.([A-Za-z0-9_.-]+)\.args=(.*)$/s;

/**
 * The elements of a TOML array of basic strings, or `null` for any other shape.
 * `coordinationArgsFor` emits exactly this form, so anything else is not ours.
 */
export function parseTomlStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) return [];
  const elements: string[] = [];
  let index = 0;
  for (;;) {
    while (index < body.length && /\s/.test(body[index]!)) index += 1;
    if (body[index] !== '"') return null;
    index += 1;
    let element = '';
    for (;;) {
      if (index >= body.length) return null;
      const character = body[index]!;
      index += 1;
      if (character === '"') break;
      if (character === '\\') {
        const escaped = body[index];
        if (escaped === undefined) return null;
        index += 1;
        element += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
        continue;
      }
      element += character;
    }
    elements.push(element);
    while (index < body.length && /\s/.test(body[index]!)) index += 1;
    if (index >= body.length) return elements;
    if (body[index] !== ',') return null;
    index += 1;
    // A trailing comma is legal TOML.
    if (body.slice(index).trim().length === 0) return elements;
  }
}

/**
 * The coordination bridge these session arguments provision, or `null` when
 * they provision none.
 *
 * `entryPath` is injectable so a test can prove the match is on the real entry
 * point rather than on the server's name; production always uses this build's.
 */
export function provisionedBridgeFromArgs(args: ReadonlyArray<string>, entryPath: string = bridgeEntryPath()): ProvisionedBridge | null {
  const wanted = path.resolve(entryPath);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-c') continue;
    const override = args[index + 1];
    if (override === undefined) continue;
    const matched = MCP_SERVER_ARGS_OVERRIDE.exec(override);
    if (matched === null) continue;
    const elements = parseTomlStringArray(matched[2]!);
    // Exactly one argument, and it is the bridge this coordinator would spawn.
    if (elements === null || elements.length !== 1 || path.resolve(elements[0]!) !== wanted) continue;
    // A head's planning session is provisioned with the same entry point; the
    // coordinator decides from the session token which of these it may call.
    return { serverName: matched[1]!, toolNames: [...ALL_BRIDGE_TOOL_NAMES] };
  }
  return null;
}
