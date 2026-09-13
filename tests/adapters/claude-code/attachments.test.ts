import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeCodeAdapter } from '../../../src/adapters/claude-code/adapter.js';
import type { UserFrame } from '../../../src/adapters/claude-code/protocol.js';
import type { RawRecord } from '../../../src/adapters/claude-code/transport.js';
import type { SessionHandle } from '../../../src/adapters/types.js';
import { collect, replayAdapter, scenarioEnv, scenarioPath, tempWorkspace } from './helpers.js';

const roots: string[] = [];
const sessions: Array<{ adapter: ClaudeCodeAdapter; handle: SessionHandle }> = [];
afterEach(async () => {
  for (const { adapter, handle } of sessions.splice(0)) await adapter.stopOwnedProcesses(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqS8AAAAASUVORK5CYII=', 'base64');

async function setup() {
  const cwd = tempWorkspace('wf-claude-attachments-'); roots.push(path.dirname(cwd));
  const wire: RawRecord[] = [];
  const adapter = replayAdapter({ onRawRecord: (_sessionId, record) => wire.push(record) });
  const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'local-development', systemInstructions: 'You are a workforce worker.', env: scenarioEnv(scenarioPath('session-hello.synthetic.json')) });
  sessions.push({ adapter, handle });
  const users = () => wire.filter((record) => record.dir === 'out').map((record) => JSON.parse(record.line) as UserFrame).filter((frame) => frame.type === 'user');
  return { cwd, adapter, handle, users };
}

describe('Claude native attachment frames', () => {
  it('forwards multiple images and a PDF as documented content blocks while binaries remain references', async () => {
    const { cwd, adapter, handle, users } = await setup();
    const first = path.join(cwd, 'first.png'), second = path.join(cwd, 'second.png'), pdf = path.join(cwd, 'document.pdf'), binary = path.join(cwd, 'archive.zip');
    writeFileSync(first, PNG); writeFileSync(second, PNG); writeFileSync(pdf, '%PDF-1.7\nfixture'); writeFileSync(binary, 'binary-context-not-in-prompt');
    const turn = await adapter.startTurn(handle, { prompt: 'Compare the attachments.', attachments: [
      { path: first, name: 'first "quoted"\nimage.png', mimeType: 'image/png' },
      { path: pdf, name: 'document.pdf', mimeType: 'application/pdf' },
      { path: second, name: 'second.png', mimeType: 'image/png' },
      { path: binary, name: 'archive.zip', mimeType: 'application/zip' },
    ] });
    await collect(adapter, turn);
    expect(users()).toHaveLength(1);
    const content = users()[0]!.message.content;
    expect(content[0]).toEqual({ type: 'text', text: expect.stringContaining(JSON.stringify(binary)) });
    expect(JSON.stringify(content)).not.toContain('binary-context-not-in-prompt');
    expect(content[1]).toEqual({ type: 'text', text: expect.stringContaining(JSON.stringify('first "quoted"\nimage.png')) });
    expect(content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    expect(content[4]).toEqual({ type: 'document', title: 'document.pdf', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.7\nfixture').toString('base64') } });
    expect(content[6]).toEqual(content[2]);
  });

  it('refuses changed attachment contents before sending a user frame and preserves queued input', async () => {
    const { cwd, adapter, handle, users } = await setup();
    const image = path.join(cwd, 'image.png'); writeFileSync(image, PNG);
    await adapter.deliver(handle, { messageId: 'keep', body: 'Keep this queued message.' });
    await expect(adapter.startTurn(handle, { prompt: 'Analyze it.', attachments: [{ path: image, name: 'image.png', mimeType: 'image/png', sha256: createHash('sha256').update('different').digest('hex') }] })).rejects.toThrow(/SHA-256/);
    expect(users()).toEqual([]);
    const turn = await adapter.startTurn(handle, { prompt: 'Continue without attachment.' }); await collect(adapter, turn);
    expect(users()).toHaveLength(1);
    expect(users()[0]!.message.content).toEqual([{ type: 'text', text: expect.stringContaining('[coordinator message keep]') }]);
  });

  it('keeps a native-capable file as a path reference when requested explicitly', async () => {
    const { cwd, adapter, handle, users } = await setup();
    const image = path.join(cwd, 'image.png'); writeFileSync(image, PNG);
    const turn = await adapter.startTurn(handle, { prompt: 'Use the file reference.', attachments: [{ path: image, name: 'image.png', mimeType: 'image/png', mode: 'reference' }] });
    await collect(adapter, turn);
    expect(users()[0]!.message.content).toEqual([{ type: 'text', text: expect.stringContaining(JSON.stringify(image)) }]);
  });
});
