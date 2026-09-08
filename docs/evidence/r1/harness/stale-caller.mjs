#!/usr/bin/env node
/**
 * R1-gate harness: a callback from an attempt that has already finished.
 * Waits, then submits to the live coordinator with the token its attempt was
 * issued. Whatever comes back is written verbatim.
 */
import { appendFileSync } from 'node:fs';
const [socket, token, out, delayMs] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Number(delayMs)));
const { callCoordinator } = await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/coordination/bridge.js');
const record = { at: new Date().toISOString(), socket, calls: {} };
for (const [name, op, params] of [
  ['send_message', 'send_message', { body: 'a late result from a finished attempt', idempotencyKey: 'at11-stale' }],
  ['report_result', 'report_result', { summary: 'the finished attempt now claims success', status: 'completed' }],
]) {
  try { record.calls[name] = await callCoordinator(socket, token, op, params); }
  catch (error) { record.calls[name] = { threw: String(error && error.message ? error.message : error) }; }
}
appendFileSync(out, JSON.stringify(record) + '\n');
