/**
 * `workforce serve` as a command (FR084): its exit codes, and a server that
 * lives until the interruption signal and is gone after it.
 */
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandServe } from '../../src/cli/commands/serve.js';
import { runCli } from '../../src/cli/index.js';
import { EXIT_CODES, Reporter } from '../../src/cli/output.js';
import { cleanupAll, tempDir } from '../workspaces/support.js';
import { rawRequest, sleep } from '../server/support.js';

afterEach(() => cleanupAll());

function sinks(): { streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }; stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return { streams: { stdout: sink((c) => (out += c)), stderr: sink((c) => (err += c)) }, stdout: () => out, stderr: () => err };
}

describe('workforce serve', () => {
  it('exits 2 for a port that is not a port, before listening on anything', async () => {
    for (const port of ['70000', 'abc', '-1', '80.5']) {
      const io = sinks();
      const code = await runCli(['serve', `--port=${port}`, '--state-dir', path.join(tempDir('workforce-serve-cli-'), 'state'), '--json'], io.streams);
      expect(code).toBe(EXIT_CODES.invalidInput);
      expect((JSON.parse(io.stdout()) as { error: { code: string } }).error.code).toBe('invalid_port');
    }
  });

  it('exits 4 when the port is taken, naming the way out', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const io = sinks();
      await expect(
        commandServe({ port: String(port), stateDir: tempDir('workforce-serve-busy-'), open: false, json: false }, { reporter: new Reporter(false, io.streams) }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.executionFailure, code: 'port_in_use' });
    } finally {
      blocker.close();
    }
  });

  it('serves until interrupted, opens the page when asked, and stops listening after', async () => {
    const io = sinks();
    const interruption = new AbortController();
    const opened: string[] = [];
    const running = commandServe(
      { port: '0', stateDir: tempDir('workforce-serve-life-'), open: true, json: false },
      { reporter: new Reporter(false, io.streams), signal: interruption.signal, openUrl: (url) => opened.push(url) },
    );
    const deadline = Date.now() + 10_000;
    while (opened.length === 0 && Date.now() < deadline) await sleep(10);
    expect(opened).toHaveLength(1);
    expect(io.stdout()).toContain(`workforce office: ${opened[0]}`);
    const port = Number(new URL(opened[0]!).port);
    expect((await rawRequest({ port }, { path: '/' })).status).toBe(200);

    interruption.abort();
    const result = await running;
    expect(result).toMatchObject({ command: 'serve', exitCode: 0, data: { stopped: true } });
    await expect(rawRequest({ port }, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
