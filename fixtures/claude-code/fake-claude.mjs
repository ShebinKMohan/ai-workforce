#!/usr/bin/env node
/**
 * Deterministic replay of a `claude --print --output-format stream-json`
 * session, for tests that must not touch the network, a model or a quota.
 *
 * It speaks the same two pipes as the installed CLI: newline-delimited JSON
 * records on stdout, newline-delimited JSON frames on stdin, plus the small
 * `control_request` / `control_response` protocol.
 *
 * DETERMINISM IS THE POINT. WP03's replay fixture used a deferred release and
 * had a race: two client frames could both be handled before the release, so
 * the second response was never emitted and its test flaked. Nothing here is
 * timed. Every record this process writes is emitted synchronously from the
 * frame that triggered it, so "the second message arrived" and "the first
 * message's records were written" cannot interleave differently between runs.
 *
 * Scenario file (JSON, `WORKFORCE_FAKE_CLAUDE_SCENARIO`):
 *
 *   {
 *     "steps": [
 *       { "on": "start",            "emit": [ ...records... ] },
 *       { "on": "user",             "emit": [ {"__replay": true}, ...records... ] },
 *       { "on": "control:interrupt","respond": { "still_queued": [] }, "emit": [ ... ] },
 *       { "on": "user",             "emit": [ ... ], "exit": 0 }
 *     ]
 *   }
 *
 * A step is consumed by the first matching trigger, in file order. Special
 * records inside `emit`:
 *   {"__replay": true}      the `--replay-user-messages` echo of the frame that
 *                           triggered this step
 *   {"__text": "…"}         a bare non-JSON line on stdout (the real CLI does
 *                           this, e.g. "No conversation found with session ID: …")
 *   {"__malformed": true}   a line that is not valid JSON
 *   {"__stderr": "…"}       a line on stderr
 *   {"__exit": 3}           exit immediately with this code
 * `{{sessionId}}` anywhere in a string is replaced with the --session-id value.
 *
 * Every other object is written verbatim as one JSON line.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

function flagValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const sessionId = flagValue('--session-id') ?? '00000000-0000-4000-8000-000000000000';

// Record the argv so a test can assert the exact flags the adapter chose.
const argvOut = process.env['WORKFORCE_FAKE_CLAUDE_ARGV_OUT'];
if (argvOut !== undefined && argvOut !== '') {
  appendFileSync(argvOut, `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid })}\n`);
}

const scenarioPath = process.env['WORKFORCE_FAKE_CLAUDE_SCENARIO'];
let steps = [];
if (scenarioPath !== undefined && scenarioPath !== '') {
  const parsed = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  steps = Array.isArray(parsed.steps) ? parsed.steps : [];
}
const consumed = new Set();

/**
 * Placeholder values. `sessionId`, `cwd` and `pid` come from this process;
 * anything else a scenario needs (an escape path, a home directory) is supplied
 * by the test through WORKFORCE_FAKE_CLAUDE_VARS as a JSON object.
 */
const vars = {
  sessionId,
  cwd: process.cwd(),
  pid: String(process.pid),
  home: process.env['HOME'] ?? '',
  scratch: process.env['TMPDIR'] ?? '/tmp',
  ...JSON.parse(process.env['WORKFORCE_FAKE_CLAUDE_VARS'] ?? '{}'),
};

function substitute(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [key, replacement] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, String(replacement));
    return out;
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, member] of Object.entries(value)) out[key] = substitute(member);
    return out;
  }
  return value;
}

function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

let ending = false;

/**
 * End the process without truncating stdout. `process.exit()` on a pipe can
 * drop buffered writes; setting the code and detaching stdin lets the event
 * loop drain and node exit on its own.
 */
function endProcess(code) {
  if (ending) return;
  ending = true;
  process.exitCode = code;
  try {
    process.stdin.pause();
    process.stdin.destroy();
  } catch {
    // stdin already gone
  }
}

function emitRecords(records, trigger) {
  for (const raw of records ?? []) {
    const record = substitute(raw);
    if (record.__replay === true) {
      if (trigger?.type === 'user') {
        writeLine(JSON.stringify({ ...trigger.frame, session_id: sessionId, uuid: `replay-${consumed.size}`, isReplay: true }));
      }
      continue;
    }
    if (typeof record.__text === 'string') {
      writeLine(record.__text);
      continue;
    }
    if (record.__malformed === true) {
      writeLine('{"type":"assistant"  this is not json');
      continue;
    }
    if (typeof record.__stderr === 'string') {
      process.stderr.write(`${record.__stderr}\n`);
      continue;
    }
    if (typeof record.__exit === 'number') {
      endProcess(record.__exit);
      return;
    }
    writeLine(JSON.stringify(record));
  }
}

/** Consume the first unconsumed step whose trigger matches; returns it or null. */
function takeStep(name) {
  for (let i = 0; i < steps.length; i += 1) {
    if (consumed.has(i)) continue;
    if (steps[i].on !== name) continue;
    consumed.add(i);
    return steps[i];
  }
  return null;
}

function runStep(name, trigger) {
  const step = takeStep(name);
  if (step === null) return null;
  emitRecords(step.emit, trigger);
  if (typeof step.exit === 'number') endProcess(step.exit);
  return step;
}

// `start` fires before any input is read.
runStep('start', null);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    handleLine(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  runStep('stdin_end', null);
  endProcess(process.exitCode ?? 0);
});

function handleLine(line) {
  if (line.trim().length === 0) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    // The installed CLI logs exactly this and exits.
    process.stderr.write(`Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError\n`);
    endProcess(1);
    return;
  }
  if (frame.type === 'control_request') {
    const step = takeStep(`control:${frame.request?.subtype}`);
    const payload = step?.respond ?? {};
    writeLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: substitute(payload) } }));
    if (step !== null) {
      emitRecords(step.emit, { type: 'control', frame });
      if (typeof step.exit === 'number') endProcess(step.exit);
    }
    return;
  }
  if (frame.type === 'user') {
    runStep('user', { type: 'user', frame });
    return;
  }
  runStep('unknown_frame', { type: 'unknown', frame });
}
