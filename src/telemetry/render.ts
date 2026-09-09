/**
 * One human line per runtime event.
 *
 * This lived inside `run-direct.ts` because the run path was the only thing
 * that rendered. It is now shared: the run path renders live, and
 * `workforce watch` re-derives the same lines from the persisted `runtime.*`
 * event rows in a second terminal. Two renderers that disagree about what a
 * `tool_result` says would be two different accounts of the same run, so
 * there is exactly one of them and it lives here.
 *
 * Nothing in this module does I/O, holds state, or knows about colour. It
 * turns a record into a string. Every line it produces that is not a
 * top-level statement is indented by two spaces; the live view treats that
 * indent as a continuation marker, so a 120-line diff stays attached to the
 * lane that produced it instead of becoming 120 labelled rows.
 */
import { RUNTIME_EVENT_KINDS, type RuntimeEvent } from '../adapters/types.js';
import { stripControl } from '../cli/ansi.js';

/**
 * One human line per meaningful runtime action, or `null` for an event that
 * should not produce one.
 *
 * Two rules keep the terminal readable without hiding anything:
 *
 * - an adapter reports the same action twice (`phase: "started"`, then
 *   `phase: "completed"`). The line is printed when the action starts, so
 *   progress is visible as it happens, and repeated on completion only when
 *   the completion carries something new — an exit code, a refusal;
 * - `raw` events are well-formed runtime output the adapter did not normalize
 *   (MCP server startup, reasoning items, token usage, unknown methods). They
 *   are counted and summarized after the turn instead of printed one by one.
 *
 * Nothing is dropped: every event still reaches `--json`, `events.jsonl` and
 * the adapter's raw capture.
 */
export function renderRuntimeEvent(event: RuntimeEvent, shorten: (value: string) => string = (value) => value): string | null {
  // Every line below interpolates something the runtime chose: a model
  // sentence, a shell command, a path, a JSON error body. That text is quoted,
  // not trusted, and a runtime quoting captured terminal output will hand us
  // real escape sequences. Stripping here means no consumer of this module —
  // the run's own terminal, the live board, `workforce watch` reading the same
  // fact back out of SQLite — has to remember to do it.
  const line = composeRuntimeEvent(event, shorten);
  return line === null ? null : stripControl(line);
}

function composeRuntimeEvent(event: RuntimeEvent, shorten: (value: string) => string): string | null {
  const payload = event.payload;
  const phase = typeof payload['phase'] === 'string' ? (payload['phase'] as string) : null;
  switch (event.kind) {
    case 'session_started': {
      const id = payload['threadId'] ?? payload['sessionId'] ?? event.sessionId;
      return `  runtime session ${String(id)} started`;
    }
    case 'turn_started':
      return '  turn started';
    case 'assistant_message':
      return `  message: ${truncateLine(String(payload['text'] ?? ''))}`;
    case 'tool_call':
      return `  tool ${String(payload['tool'] ?? 'unknown')}${payload['path'] !== undefined ? ` ${shorten(String(payload['path']))}` : ''}`;
    case 'tool_result': {
      const outcome = payload['status'] ?? (payload['ok'] === true ? 'ok' : payload['ok'] === false ? 'failed' : payload['isError'] === false ? 'ok' : payload['isError'] === true ? 'failed' : 'outcome not reported');
      return `  tool ${String(payload['tool'] ?? 'unknown')} -> ${String(outcome)}`;
    }
    case 'file_change': {
      const where = payload['path'] === null || payload['path'] === undefined ? '(path not reported)' : shorten(String(payload['path']));
      if (payload['denied'] === true) return `  change denied: ${where}`;
      const outside = payload['withinAllowedPaths'] === false;
      // A request is not a change. The line says which it is, because a write
      // the model merely asked for and a write that landed are different facts
      // — and for a runtime with no sandbox that is the whole distinction.
      if (phase === 'requested') return outside ? `  requested a write to ${where} (OUTSIDE the granted paths)` : null;
      if (phase === 'started') return null;
      if (payload['applied'] === false || payload['applied'] === null) {
        return outside ? `  write to ${where} not confirmed by the runtime (OUTSIDE the granted paths)` : `  write to ${where} not confirmed by the runtime`;
      }
      return outside ? `  changed ${where} (OUTSIDE the granted paths; not part of the candidate)` : `  changed ${where}`;
    }
    case 'command_exec': {
      const command = truncateLine(String(payload['command'] ?? ''));
      if (phase === 'started' || phase === null) return `  exec ${command}`;
      if (payload['denied'] === true) return `  exec denied: ${command}`;
      const exitCode = payload['exitCode'];
      return typeof exitCode === 'number' ? `  exec -> exit ${exitCode}` : null;
    }
    case 'turn_completed':
      return '  turn completed';
    case 'turn_interrupted':
      return '  turn interrupted';
    case 'error':
      return `  runtime error: ${truncateLine(JSON.stringify(payload))}`;
    case 'raw':
      // Counted and summarized once the turn ends; see the caller.
      return null;
    default:
      return `  ${event.kind}`;
  }
}

/**
 * The same rendering, from a persisted event row rather than a live
 * `RuntimeEvent`.
 *
 * `runtimeEventToAppend` writes each runtime event as type `runtime.<kind>`
 * with the adapter's payload spread FLAT over the event's own base fields
 * (`adapter`, `sessionId`, `turnId`, `spawnToken`, `runtimeSequence`,
 * `rawRef`), so the row payload is exactly what the renderer wants plus six
 * fields it never reads — except `sessionId`, which carries the same value
 * the live path would have read off the event. That is why `workforce watch`
 * can reconstruct, from the database alone, the line the run's own terminal
 * printed.
 *
 * Returns `null` for a row that is not a runtime event at all, which is how a
 * caller tells "this row has no rendering" from "this row is not mine".
 */
export function renderPersistedRuntimeEvent(
  type: string,
  payload: Record<string, unknown>,
  shorten: (value: string) => string = (value) => value,
): string | null {
  if (!type.startsWith('runtime.')) return null;
  const kind = type.slice('runtime.'.length);
  if (!(RUNTIME_EVENT_KINDS as ReadonlyArray<string>).includes(kind)) return null;
  return renderRuntimeEvent({ kind, payload, sessionId: String(payload['sessionId'] ?? '') } as unknown as RuntimeEvent, shorten);
}

export const MAX_PATCH_PREVIEW_LINES = 120;

/**
 * The candidate diff as terminal lines, cut off at a bounded length. A big
 * change must not flood the terminal, and the cut is stated rather than left
 * for the reader to notice; the complete patch is always on disk.
 */
export function previewPatch(patch: string, maxLines = MAX_PATCH_PREVIEW_LINES): string[] {
  // The diff is repository content, so it is exactly as untrusted as anything
  // else the worker wrote: a single line of a source file carrying an escape
  // sequence used to reach the terminal through this preview.
  const lines = patch.split('\n').map(stripControl);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.map((line) => `  ${line}`);
  const shown = lines.slice(0, maxLines).map((line) => `  ${line}`);
  shown.push(`  … ${lines.length - maxLines} more diff line(s); the complete patch is candidate.patch`);
  return shown;
}

export function truncateLine(text: string, max = 160): string {
  // `\s+` collapses the whitespace controls and misses every other one, which
  // is how an ESC survived into a one-line summary of a model's message.
  const single = stripControl(text).replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
