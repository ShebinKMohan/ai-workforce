#!/usr/bin/env node
/**
 * Deterministic replay of a recorded Codex app-server transcript.
 *
 * The adapter is driven against this script instead of the real `codex`
 * binary so framing, normalization, steering, interruption and shutdown can
 * be tested without a network call, a model turn or a paid quota.
 *
 * Transcript format: one JSON object per line.
 *   { "dir": "out", "line": "<client -> server frame>" }
 *   { "dir": "in",  "line": "<server -> client frame>" }
 *   { "dir": "note", "text": "..." }                      ignored, for provenance
 *   { "dir": "hold", "ms": 250 }                          delay before the next frame
 *
 * Replay rule: emit every leading `in` record, then wait. Each client frame
 * consumes the next `out` record and releases the `in` records that follow it,
 * up to the next `out` record. Response ids are rewritten to the id the client
 * actually used, so replay does not depend on matching id numbering; server ->
 * client request ids are left alone, because the client answers them by id.
 *
 * Consuming the `out` record and releasing the `in` records that follow it are
 * one step in the `writing` chain, never split across it. Two client frames
 * can arrive in a single stdin chunk — `initialized` and the request that
 * follows it routinely do — and advancing the cursor outside the chain made
 * the second frame skip its own `out` record, so its response was never
 * emitted and the client waited for a reply that could not come.
 *
 * Options:
 *   --transcript <path>   required
 *   --chunk <bytes>       write stdout in fixed-size chunks, splitting JSON
 *                         lines, to exercise partial-line buffering
 *   --exit-after <n>      exit(0) after emitting n server frames
 *   --hang                ignore SIGTERM, to test escalation to SIGKILL
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { transcript: null, chunk: 0, exitAfter: 0, hang: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transcript') out.transcript = argv[++i];
    else if (arg === '--chunk') out.chunk = Number(argv[++i]);
    else if (arg === '--exit-after') out.exitAfter = Number(argv[++i]);
    else if (arg === '--hang') out.hang = true;
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
if (options.transcript === null) {
  process.stderr.write('fake-app-server: --transcript <path> is required\n');
  process.exit(64);
}
if (options.hang) {
  process.on('SIGTERM', () => {
    process.stderr.write('fake-app-server: ignoring SIGTERM\n');
  });
  process.on('SIGINT', () => {});
  // Keep the event loop alive so only SIGKILL can end this process.
  setInterval(() => {}, 1000);
}

const records = readFileSync(options.transcript, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))
  .filter((record) => record.dir !== 'note');

let cursor = 0;
let emitted = 0;
const pendingIds = [];
let writing = Promise.resolve();

function write(text) {
  if (options.chunk > 0) {
    for (let i = 0; i < text.length; i += options.chunk) process.stdout.write(text.slice(i, i + options.chunk));
    return;
  }
  process.stdout.write(text);
}

function emitFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    write(`${line}\n`);
    emitted += 1;
    return;
  }
  const isResponse = frame.id !== undefined && frame.method === undefined;
  if (isResponse && pendingIds.length > 0) frame.id = pendingIds.shift();
  write(`${JSON.stringify(frame)}\n`);
  emitted += 1;
  if (options.exitAfter > 0 && emitted >= options.exitAfter) process.exit(0);
}

async function releaseUntilNextClientFrame() {
  while (cursor < records.length) {
    const record = records[cursor];
    if (record.dir === 'out') return;
    cursor += 1;
    if (record.dir === 'hold') {
      await new Promise((resolve) => setTimeout(resolve, Number(record.ms) || 0));
      continue;
    }
    if (record.dir === 'in') emitFrame(record.line);
  }
}

function schedule(task) {
  writing = writing.then(task).catch((error) => {
    process.stderr.write(`fake-app-server: ${error.message}\n`);
  });
  return writing;
}

function onClientFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-app-server: undecodable client frame: ${line.slice(0, 200)}\n`);
    return;
  }
  // Requests get a response; the client's own answers to server requests do not.
  if (frame.id !== undefined && frame.method !== undefined) pendingIds.push(frame.id);
  schedule(async () => {
    if (cursor < records.length && records[cursor].dir === 'out') cursor += 1;
    await releaseUntilNextClientFrame();
  });
}

schedule(releaseUntilNextClientFrame);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length > 0) onClientFrame(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (!options.hang) process.exit(0);
});
