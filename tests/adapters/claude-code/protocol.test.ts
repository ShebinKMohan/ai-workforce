/**
 * Pure protocol behaviour: the argv the adapter builds, the line decoder, the
 * policy mapping and the usage/cost reading. Every expectation here is pinned
 * to something observed on the installed claude 2.1.260; the comments say which.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_LEVELS,
  buildClaudeArgs,
  classifyClaudeError,
  decodeStreamLine,
  mapPolicy,
  parseClaudeVersion,
  userFrame,
  controlRequestFrame,
} from '../../../src/adapters/claude-code/protocol.js';
import { readUsage, UNDISCOVERED_CLAUDE_SETTINGS } from '../../../src/adapters/claude-code/adapter.js';
import { validateSettingsAgainst } from '../../../src/adapters/types.js';

const BASE = {
  sessionId: '01a07b89-ce9e-7011-83d8-240e0ae83960',
  policy: 'local-development' as const,
  mapping: mapPolicy('local-development'),
  allowedWritePaths: ['/tmp/a', '/tmp/b'],
  systemInstructions: 'You are a worker.',
};

describe('version parsing', () => {
  it('reads the installed executable version line', () => {
    // `claude --version` on the recording machine printed exactly this.
    expect(parseClaudeVersion('2.1.260 (Claude Code)\n')).toBe('2.1.260');
  });

  it('returns null for anything else rather than guessing', () => {
    expect(parseClaudeVersion('claude 2.1.260')).toBeNull();
    expect(parseClaudeVersion('')).toBeNull();
  });
});

describe('argv', () => {
  const args = buildClaudeArgs(BASE);

  it('drives the documented programmatic mode with a stream on both pipes', () => {
    expect(args.slice(0, 7)).toEqual(['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--replay-user-messages']);
  });

  it('always passes --verbose, which this build requires with --print and stream-json', () => {
    // Executed: omitting it fails with
    // "Error: When using --print, --output-format=stream-json requires --verbose".
    expect(args).toContain('--verbose');
  });

  it('never inherits the user\'s MCP servers or settings files', () => {
    // Executed: without --strict-mcp-config the user's global MCP servers appear
    // in the init record; without --setting-sources '' a `.claude/settings.json`
    // SessionStart hook in the session's own cwd ran.
    expect(args).toContain('--strict-mcp-config');
    const sources = args.indexOf('--setting-sources');
    expect(sources).toBeGreaterThanOrEqual(0);
    expect(args[sources + 1]).toBe('');
  });

  it('closes every variadic option with a non-variadic one', () => {
    // Executed: `--tools Read "say hi"` consumed the prompt as a tool name and
    // failed with "Input must be provided either through stdin or as a prompt
    // argument". The adapter never passes a positional prompt, and still shapes
    // the argv so no bare word can be swallowed.
    for (const variadic of ['--tools', '--add-dir']) {
      const index = args.indexOf(variadic);
      expect(index, `${variadic} is present`).toBeGreaterThanOrEqual(0);
      let next = index + 1;
      while (next < args.length && !args[next]!.startsWith('--')) next += 1;
      expect(next, `${variadic} is followed by another option, not the end of the argv`).toBeLessThan(args.length);
    }
    expect(args[args.length - 1]).toBe('You are a worker.');
    expect(args[args.length - 2]).toBe('--append-system-prompt');
  });

  it('grants exactly the profile\'s tools and no shell', () => {
    const toolsIndex = args.indexOf('--tools');
    const tools: string[] = [];
    for (let i = toolsIndex + 1; i < args.length && !args[i]!.startsWith('--'); i += 1) tools.push(args[i]!);
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    expect(tools).not.toContain('Bash');
  });

  it('denies anything that would prompt', () => {
    const index = args.indexOf('--permission-prompts');
    expect(args[index + 1]).toBe('none');
  });

  it('passes the session id we minted', () => {
    const index = args.indexOf('--session-id');
    expect(args[index + 1]).toBe(BASE.sessionId);
  });

  it('resumes with --resume alone, because this build refuses --session-id beside it', () => {
    // Executed: `--resume <id> --session-id <id>` fails with
    // "Error: --session-id can only be used with --continue or --resume if
    // --fork-session is also specified." The resumed conversation keeps the id
    // we minted when it was first opened, so nothing is lost by omitting it.
    expect(args).not.toContain('--resume');
    const resumed = buildClaudeArgs({ ...BASE, resume: BASE.sessionId });
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(BASE.sessionId);
    expect(resumed).not.toContain('--session-id');
    expect(resumed).not.toContain('--fork-session');

    const forked = buildClaudeArgs({ ...BASE, sessionId: 'new-id', resume: BASE.sessionId, forkSession: true });
    expect(forked[forked.indexOf('--resume') + 1]).toBe(BASE.sessionId);
    expect(forked).toContain('--fork-session');
    expect(forked[forked.indexOf('--session-id') + 1]).toBe('new-id');
  });

  it('passes model, effort and budget only when configured', () => {
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('--max-budget-usd');
    const configured = buildClaudeArgs({ ...BASE, model: 'sonnet', effort: 'low', maxBudgetUsd: 0.5 });
    expect(configured[configured.indexOf('--model') + 1]).toBe('sonnet');
    expect(configured[configured.indexOf('--effort') + 1]).toBe('low');
    expect(configured[configured.indexOf('--max-budget-usd') + 1]).toBe('0.5');
  });
});

describe('policy mapping', () => {
  it('gives analysis a read-only posture with no writers and no shell', () => {
    const mapping = mapPolicy('analysis');
    expect(mapping.permissionMode).toBe('plan');
    expect(mapping.restricted).toBe(true);
    expect(mapping.writeCandidate).toBe(false);
    expect(mapping.tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('gives local-development the file writers but not a shell', () => {
    const mapping = mapPolicy('local-development');
    expect(mapping.permissionMode).toBe('acceptEdits');
    expect(mapping.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    expect(mapping.tools).not.toContain('Bash');
  });

  it('always records that this runtime provides no process containment', () => {
    for (const policy of ['analysis', 'local-development', 'verification'] as const) {
      const aspects = mapPolicy(policy).unenforceable.map((u) => u.aspect);
      expect(aspects).toContain('process_containment');
      expect(aspects).toContain('worker_network');
      expect(aspects).toContain('external_delivery');
    }
  });

  it('says out loud that granting a shell removes the write boundary', () => {
    const mapping = mapPolicy('local-development', { allowCommandExecution: true });
    expect(mapping.tools).toContain('Bash');
    const confinement = mapping.unenforceable.find((u) => u.aspect === 'write_confinement');
    expect(confinement?.reason).toContain('not a file tool');
  });

  it('marks verification as this adapter\'s non-job', () => {
    const aspects = mapPolicy('verification').unenforceable.map((u) => u.aspect);
    expect(aspects).toContain('verification_profile');
  });
});

describe('line decoding', () => {
  it('decodes a record', () => {
    const decoded = decodeStreamLine('{"type":"result","subtype":"success"}');
    expect(decoded).toMatchObject({ kind: 'record', type: 'result' });
  });

  it('keeps a bare text line as evidence instead of throwing', () => {
    // Executed: `--resume <unknown uuid>` printed this line on stdout, before JSON.
    const decoded = decodeStreamLine('No conversation found with session ID: 999');
    expect(decoded).toEqual({ kind: 'text', line: 'No conversation found with session ID: 999' });
  });

  it('keeps JSON without a type as evidence', () => {
    expect(decodeStreamLine('[1,2,3]')).toEqual({ kind: 'foreign', value: [1, 2, 3] });
    expect(decodeStreamLine('42')).toEqual({ kind: 'foreign', value: 42 });
  });

  it('preserves unknown fields on a known record', () => {
    const decoded = decodeStreamLine('{"type":"result","subtype":"success","from_the_future":{"a":1}}');
    expect(decoded.kind).toBe('record');
    if (decoded.kind !== 'record') throw new Error('unreachable');
    expect(decoded.value['from_the_future']).toEqual({ a: 1 });
  });
});

describe('input frames', () => {
  it('shapes a user frame the way the installed build accepts', () => {
    expect(userFrame('sid', 'hello')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: 'sid',
    });
  });

  it('shapes a control request the way the installed build answers', () => {
    expect(controlRequestFrame('req_1', 'interrupt')).toEqual({ type: 'control_request', request_id: 'req_1', request: { subtype: 'interrupt' } });
  });
});

describe('error classification', () => {
  it('recognises the authentication failure this machine actually produced', () => {
    expect(classifyClaudeError({ error: 'authentication_failed' })).toBe('authentication');
    expect(classifyClaudeError({ message: 'Failed to authenticate: OAuth session expired and could not be refreshed' })).toBe('authentication');
  });

  it('recognises a missing conversation', () => {
    expect(classifyClaudeError({ message: 'No conversation found with session ID: 999' })).toBe('invalid_request');
  });

  it('leaves an unrecognised failure unknown rather than guessing it retryable', () => {
    expect(classifyClaudeError({ subtype: 'success', message: 'something new' })).toBe('unknown');
  });
});

describe('settings validation', () => {
  it('refuses an effort level the runtime would silently replace', () => {
    // Executed: `--effort not-a-level` printed "Warning: Unknown --effort value
    // 'not-a-level' — ignoring it and using the default effort" and continued.
    const validation = validateSettingsAgainst('claude-code', UNDISCOVERED_CLAUDE_SETTINGS, { effort: 'not-a-level' });
    expect(validation.ok).toBe(false);
    expect(validation.effort.status).toBe('unsupported');
  });

  it('accepts every effort level the executable documents', () => {
    for (const level of CLAUDE_EFFORT_LEVELS) {
      expect(validateSettingsAgainst('claude-code', UNDISCOVERED_CLAUDE_SETTINGS, { effort: level }).ok).toBe(true);
    }
  });

  it('passes an unlisted model through unchanged rather than mapping it', () => {
    const validation = validateSettingsAgainst('claude-code', UNDISCOVERED_CLAUDE_SETTINGS, { model: 'claude-fable-5-1' });
    expect(validation.ok).toBe(true);
    expect(validation.model.status).toBe('supported_unverified');
  });
});

describe('usage and cost (FR060, AT14)', () => {
  it('reports cost as measured when the turn reached the provider', () => {
    const usage = readUsage({ usage: { input_tokens: 1200, output_tokens: 40 }, total_cost_usd: 0.0123, duration_api_ms: 4210, duration_ms: 5400 });
    expect(usage.costStatus).toBe('measured');
    expect(usage.costUsd).toBe(0.0123);
    expect(usage.inputTokens).toBe(1200);
  });

  it('never reports zero for a turn that made no provider call', () => {
    // Executed shape: every turn on the recording machine failed authentication
    // locally and reported total_cost_usd 0 with duration_api_ms 0.
    const usage = readUsage({ usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, duration_api_ms: 0, duration_ms: 63 });
    expect(usage.costStatus).toBe('unavailable');
    expect(usage.costUsd).toBeNull();
    expect(usage.costDetail).toContain('no provider call');
  });

  it('reports cost unavailable when the record carries no usable number', () => {
    const usage = readUsage({ usage: { input_tokens: 10, output_tokens: 2 }, duration_api_ms: 900 });
    expect(usage.costStatus).toBe('unavailable');
    expect(usage.costUsd).toBeNull();
  });
});
