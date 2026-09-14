import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { CreateIssueSchema } from '../../src/issues/contracts.js';
import { IssueStore } from '../../src/issues/store.js';
import { runMcpServer } from '../../src/mcp/server.js';
import { startOfficeServer } from '../../src/server/index.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';

it('uses the real issue API for durable MCP saves and bounded pages of 33 large PRDs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workforce-mcp-issues-'));
  updateWorkspace(root, (config) => applyWorkspaceOps(config, parseWorkspaceOps([{ op: 'project.add', name: 'one', repoPath: '/fixture/project-one' }])));
  const store = new IssueStore(root);
  const description = '# Original PRD\n\n' + 'x'.repeat(64_000 - '# Original PRD\n\n'.length);
  const seeded = Array.from({ length: 33 }, (_unused, index) => store.create(CreateIssueSchema.parse({ projectId: 'one', title: `PRD ${index}`, description, kind: 'prd', idempotencyKey: `seed:${index}` })));
  let spawns = 0;
  const server = await startOfficeServer({
    stateRoot: root, port: 0, discover: async () => [],
    spawner: () => { spawns += 1; throw new Error('This test must not start a runtime'); },
  });
  const exchange = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    let output = '';
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    ];
    await runMcpServer({ serverUrl: server.url, input: Readable.from(frames.map((frame) => JSON.stringify(frame) + '\n')), output: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }) });
    const response = output.trim().split('\n').map((line) => JSON.parse(line)).find((frame) => frame.id === 2);
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(false);
    return response.result.structuredContent as Record<string, any>;
  };
  try {
    const projects = await exchange('workforce_list_projects', {});
    expect(projects.projects[0].id).toBe('one');
    const first = await exchange('workforce_list_issues', { projectId: 'one', limit: 20 });
    expect(first.issues).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.issues.every((issue: Record<string, unknown>) => issue['description'] === undefined)).toBe(true);
    const second = await exchange('workforce_list_issues', { projectId: 'one', limit: 20, cursor: first.nextCursor });
    expect(second.issues).toHaveLength(13);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.issues, ...second.issues].map((issue) => issue.id)).size).toBe(33);
    const detail = await exchange('workforce_get_issue', { issueId: seeded[0]!.id });
    expect(detail.issue.description).toBe(description);

    const args = { projectId: 'one', title: 'Save without execution', description: '# Full text\n\nLiteral `$(no)` and Unicode 日本語.\n', kind: 'prd', idempotencyKey: 'mcp-save:v1' };
    const saved = await exchange('workforce_submit_plan', args);
    const replayed = await exchange('workforce_submit_plan', args);
    expect(replayed.issue.id).toBe(saved.issue.id);
    expect(saved.issue.description).toBe(args.description);
    expect(saved.issue.requestId).toBeNull();
    expect(new IssueStore(root).list('one')).toHaveLength(34);
    expect(spawns).toBe(0);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
