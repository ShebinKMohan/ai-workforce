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
 * Scenario file: {"scenarioVersion":1, "steps":[...], "turns":[[...],[...]]}
 *   turn N executes `turns[N]` when present, otherwise `steps`.
 * Steps:
 *   {"action":"edit_file","path":"rel/path","content":"..."}   write a file inside cwd
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      emit('file_change', { turnId, path: target, withinCwd: target.startsWith(cwd + path.sep) });
      emit('tool_result', { turnId, tool: 'write_file', ok: true });
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
      emit('file_change', { turnId, path: target, withinCwd: false, succeeded, error });
      emit('tool_result', { turnId, tool: 'write_file', ok: succeeded });
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

async function runTurn(turnId, prompt) {
  activeTurn = turnId;
  interruptRequested = false;
  const index = turnCounter;
  turnCounter += 1;
  const steps = Array.isArray(scenario.turns) && scenario.turns[index] ? scenario.turns[index] : (scenario.steps ?? []);
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
