#!/usr/bin/env node
/**
 * Deterministic fake coding runtime for tests.
 *
 * Protocol (fake/1):
 *   argv: [--scenario <file>] [--session <id>] [--model <id>] [--effort <level>] [--version]
 *   The effective model/effort (explicit or the runtime default) is echoed in session_started.
 *   stdin  : JSON lines  {"cmd":"turn","turnId","prompt"} | {"cmd":"deliver","messageId","body"}
 *                        {"cmd":"interrupt","turnId"} | {"cmd":"shutdown"}
 *   stdout : JSON lines  {"event":<name>, ...fields}
 *
 * Scenario file: {"scenarioVersion":1, "steps":[...], "turns":[[...],[...]], "byPrompt":[{"includes":"...", "steps":[...], "turns":[...]}]}
 *   turn N executes `turns[N]` when present, otherwise `steps`.
 *   `byPrompt` is checked first: the first entry whose `includes` is a substring
 *   of the turn's prompt and/or whose `startsWith` begins it supplies the steps
 *   (its own `turns[N]`, else its `steps`). One scenario file can so script a
 *   department head and each of its workers, which receive different prompts.
 *   {"action":"call_tool","tool":"...","arguments":{...},"server":"workforce"}
 *                                                              call an MCP tool the coordinator provided
 *     (WORKFORCE_FAKE_MCP_CONFIG holds {"mcpServers":{...}}; the server is spawned and spoken to over stdio,
 *      exactly as a real runtime would)
 * Steps:
 *   {"action":"edit_file","path":"rel/path","content":"..."}   write a file inside cwd
 *   {"action":"delete_file","path":"rel/path"}                  delete a file inside cwd
 *   {"action":"claim_done","message":"..."}                     print a done claim without editing
 *   {"action":"sleep","ms":250}                                 interruptible pause
 *   {"action":"write_outside","name":"escape.txt"}              attempt a write outside cwd (../name)
 *   {"action":"exit","code":3}                                  exit unexpectedly mid-turn
 *   {"action":"hang"}                                           spawn a child and stop responding until SIGTERM
 *   {"action":"unknown_event"}                                  emit an event kind the adapter does not know
 *   {"action":"malformed_output"}                               emit a non-JSON line and a JSON line without an event name
 *   {"action":"message","text":"..."}                           plain assistant message
 *
 * Every event carries an extra `fakeExtra` field that adapters must ignore.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-runtime/1\n');
  process.exit(0);
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

const scenarioPath = argValue('--scenario');
const sessionId = argValue('--session') ?? `fake-${randomUUID()}`;
const resumed = argValue('--session') !== null;
const cwd = process.cwd();
const SUPPORTED_MODELS = ['fake-default', 'fake-fast'];
const SUPPORTED_EFFORTS = ['low', 'medium', 'high'];
const model = argValue('--model') ?? 'fake-default';
const effort = argValue('--effort') ?? 'medium';
if (!SUPPORTED_MODELS.includes(model) || !SUPPORTED_EFFORTS.includes(effort)) {
  process.stderr.write(`unsupported model/effort: ${model}/${effort}\n`);
  process.exit(64);
}

let scenario = { scenarioVersion: 1, steps: [{ action: 'claim_done', message: 'done' }] };
if (scenarioPath !== null) {
  scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
}

let sequence = 0;
function emit(event, fields = {}, callback) {
  sequence += 1;
  const line = `${JSON.stringify({ event, seq: sequence, fakeExtra: { ignored: true, n: sequence }, ...fields })}\n`;
  process.stdout.write(line, callback);
}

const inbox = [];
let activeTurn = null;
let interruptRequested = false;
let wakeSleep = null;
let turnCounter = 0;
let hung = false;

function sleepInterruptible(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve('elapsed');
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve('interrupted');
    };
  });
}

async function runStep(turnId, step) {
  switch (step.action) {
    case 'edit_file': {
      const target = path.resolve(cwd, step.path ?? 'fake-edit.txt');
      emit('tool_call', { turnId, tool: 'write_file', path: target });
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, step.content ?? `edited by fake runtime turn ${turnId}\n`);
      // `applied` and `status` are the shared payload vocabulary every consumer
      // reads: a write that landed is not the same event as one that was asked for.
      emit('file_change', { turnId, itemId: `edit-${turnId}-${step.path ?? 'fake-edit.txt'}`, path: target, withinCwd: target.startsWith(cwd + path.sep), applied: true, denied: false, phase: 'completed' });
      emit('tool_result', { turnId, tool: 'write_file', status: 'ok', ok: true });
      return;
    }
    case 'delete_file': {
      const target = path.resolve(cwd, step.path ?? 'fake-edit.txt');
      emit('tool_call', { turnId, tool: 'delete_file', path: target });
      let removed = true;
      try {
        rmSync(target, { force: false, recursive: step.recursive === true });
      } catch (err) {
        removed = false;
        emit('error', { turnId, code: 'delete_failed', path: target, detail: String(err && err.code ? err.code : err), fatal: false });
      }
      if (removed) emit('file_change', { turnId, itemId: `delete-${turnId}-${step.path ?? 'fake-edit.txt'}`, path: target, withinCwd: target.startsWith(cwd + path.sep), deleted: true, applied: true, denied: false, phase: 'completed' });
      emit('tool_result', { turnId, tool: 'delete_file', status: removed ? 'ok' : 'failed', ok: removed });
      return;
    }
    case 'claim_done':
      emit('assistant_message', { turnId, text: step.message ?? 'All done, the task is complete.', claimsDone: true });
      return;
    case 'message':
      emit('assistant_message', { turnId, text: step.text ?? '' });
      return;
    case 'sleep': {
      emit('command_exec', { turnId, command: 'sleep', ms: step.ms ?? 100 });
      await sleepInterruptible(step.ms ?? 100);
      return;
    }
    case 'write_outside': {
      const target = path.resolve(cwd, '..', step.name ?? `fake-escape-${process.pid}.txt`);
      emit('tool_call', { turnId, tool: 'write_file', path: target });
      let succeeded = true;
      let error = null;
      try {
        writeFileSync(target, `escape attempt from ${cwd}\n`);
      } catch (err) {
        succeeded = false;
        error = String(err && err.code ? err.code : err);
      }
      emit('file_change', { turnId, itemId: `escape-${turnId}`, path: target, withinCwd: false, succeeded, error, applied: succeeded, denied: !succeeded, phase: 'completed' });
      emit('tool_result', { turnId, tool: 'write_file', status: succeeded ? 'ok' : 'failed', ok: succeeded });
      return;
    }
    case 'exit': {
      const code = step.code ?? 3;
      emit('assistant_message', { turnId, text: `exiting unexpectedly with code ${code}` }, () => process.exit(code));
      await new Promise(() => {});
      return;
    }
    case 'hang': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      emit('command_exec', { turnId, command: 'hang', childPid: child.pid });
      hung = true;
      await new Promise(() => {});
      return;
    }
    case 'call_tool': {
      const tool = typeof step.tool === 'string' ? step.tool : '';
      const server = typeof step.server === 'string' ? step.server : 'workforce';
      const toolArguments = step.arguments && typeof step.arguments === 'object' ? step.arguments : {};
      emit('tool_call', { turnId, tool, server, arguments: toolArguments });
      const outcome = await callMcpTool(server, tool, toolArguments);
      emit('tool_result', { turnId, tool, server, status: outcome.ok ? 'ok' : 'failed', ok: outcome.ok, result: outcome.result, error: outcome.error });
      return;
    }
    case 'unknown_event':
      emit('fake_custom_event', { turnId, weird: { nested: [1, 2, 3] }, note: 'adapters must not crash on this' });
      return;
    case 'malformed_output':
      // Written directly so no `event` wrapper is added: the adapter must keep the stream alive.
      process.stdout.write('this line is not json {\n');
      process.stdout.write('{"seq":-1,"noEventName":true}\n');
      return;
    default:
      emit('error', { turnId, code: 'unknown_step', step, fatal: false });
  }
}

const MCP_CONFIG_ENV = 'WORKFORCE_FAKE_MCP_CONFIG';

/**
 * Call one tool on an MCP server the coordinator configured for this session:
 * spawn it (argv array, no shell), initialize, tools/call, close. Returns the
 * tool's structured result; never throws.
 */
async function callMcpTool(serverName, tool, toolArguments) {
  const raw = process.env[MCP_CONFIG_ENV];
  if (raw === undefined || raw.length === 0) return { ok: false, result: null, error: `no MCP server was provided to this session (${MCP_CONFIG_ENV} is unset)` };
  let server;
  try {
    server = JSON.parse(raw)?.mcpServers?.[serverName];
  } catch (err) {
    return { ok: false, result: null, error: `${MCP_CONFIG_ENV} is not valid JSON: ${String(err)}` };
  }
  if (!server || typeof server.command !== 'string') return { ok: false, result: null, error: `no MCP server named "${serverName}" was provided` };

  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, server.env ?? {});
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const resolve = pending.get(message?.id);
        if (resolve !== undefined) {
          pending.delete(message.id);
          resolve(message);
        }
      } catch {
        // Not a frame; ignored like any other noise.
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.once('error', (err) => {
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ error: { message: `the MCP server could not be started: ${String(err)}` } });
    }
  });
  child.stdin.on('error', () => {});
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `no answer to ${method} within 15s` } });
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-runtime', version: '1' } });
    if (init.error !== undefined) return { ok: false, result: null, error: init.error.message };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const response = await request('tools/call', { name: tool, arguments: toolArguments });
    if (response.error !== undefined) return { ok: false, result: null, error: response.error.message };
    const result = response.result ?? {};
    const structured = result.structuredContent ?? null;
    return { ok: result.isError !== true, result: structured, error: result.isError === true ? JSON.stringify(structured ?? result.content ?? null) : null };
  } finally {
    child.stdin.end();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function matchesPrompt(candidate, prompt) {
  if (candidate === null || typeof candidate !== 'object') return false;
  const text = String(prompt);
  const hasIncludes = typeof candidate.includes === 'string';
  const hasStart = typeof candidate.startsWith === 'string';
  if (!hasIncludes && !hasStart) return false;
  return (!hasIncludes || text.includes(candidate.includes)) && (!hasStart || text.startsWith(candidate.startsWith));
}

function stepsForTurn(index, prompt) {
  if (Array.isArray(scenario.byPrompt)) {
    const entry = scenario.byPrompt.find((candidate) => matchesPrompt(candidate, prompt));
    if (entry !== undefined) return Array.isArray(entry.turns) && entry.turns[index] ? entry.turns[index] : (entry.steps ?? []);
  }
  return Array.isArray(scenario.turns) && scenario.turns[index] ? scenario.turns[index] : (scenario.steps ?? []);
}

async function runTurn(turnId, prompt) {
  activeTurn = turnId;
  interruptRequested = false;
  const index = turnCounter;
  turnCounter += 1;
  const steps = stepsForTurn(index, prompt);
  const delivered = inbox.splice(0, inbox.length);
  emit('turn_started', { turnId, prompt, inbox: delivered, turnIndex: index });
  for (const step of steps) {
    if (interruptRequested) break;
    await runStep(turnId, step);
  }
  if (interruptRequested) {
    emit('turn_interrupted', { turnId, status: 'interrupted' });
  } else {
    emit('turn_completed', { turnId, status: 'completed', stepsExecuted: steps.length });
  }
  activeTurn = null;
}

function handleCommand(line) {
  if (hung) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit('error', { code: 'malformed_command', line, fatal: false });
    return;
  }
  switch (command.cmd) {
    case 'turn':
      if (activeTurn !== null) {
        emit('error', { turnId: command.turnId, code: 'turn_active', activeTurn, fatal: false });
        return;
      }
      void runTurn(command.turnId ?? `turn-${turnCounter + 1}`, command.prompt ?? '');
      return;
    case 'deliver':
      if (activeTurn !== null) {
        emit('message_received', { turnId: activeTurn, messageId: command.messageId, during: 'turn', body: command.body });
      } else {
        inbox.push({ messageId: command.messageId, body: command.body });
        emit('message_queued', { turnId: null, messageId: command.messageId, queued: inbox.length });
      }
      return;
    case 'interrupt':
      if (activeTurn !== null && (command.turnId === undefined || command.turnId === activeTurn)) {
        interruptRequested = true;
        if (wakeSleep !== null) wakeSleep();
      }
      return;
    case 'shutdown':
      emit('session_closed', { turnId: null, reason: 'shutdown' }, () => process.exit(0));
      return;
    default:
      emit('error', { code: 'unknown_command', cmd: command.cmd, fatal: false });
  }
}

emit('session_started', { turnId: null, sessionId, pid: process.pid, resumed, protocol: 'fake/1', cwd, scenario: scenarioPath, model, effort });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', handleCommand);
rl.on('close', () => {
  if (!hung) {
    emit('session_closed', { turnId: activeTurn, reason: 'stdin_closed' }, () => process.exit(0));
  }
});
