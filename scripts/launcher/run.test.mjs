import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkspace } from '../run.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

function wrapperFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workforce-run-')));
  const repo = path.join(root, 'Source with spaces');
  const outside = path.join(root, 'Other working directory');
  const nodeDir = path.join(root, 'Node runtime with spaces');
  for (const directory of [path.join(repo, 'scripts'), outside, nodeDir]) mkdirSync(directory, { recursive: true });
  for (const name of ['run.sh', 'Run Workforce.command']) {
    copyFileSync(path.join(sourceRoot, name), path.join(repo, name));
    chmodSync(path.join(repo, name), 0o755);
  }
  const node = path.join(nodeDir, 'node');
  symlinkSync(process.execPath, node);
  writeFileSync(path.join(repo, 'scripts/run.mjs'), 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), path: process.env.PATH }));');
  return { root, repo, outside, nodeDir, node };
}

for (const launcher of ['run.sh', 'Run Workforce.command']) {
  test(`${launcher} resolves source with spaces from an external directory and a minimal PATH`, () => {
    const f = wrapperFixture();
    try {
      const result = spawnSync('/bin/sh', [path.join(f.repo, launcher), '--no-open', 'argument with spaces'], {
        cwd: f.outside,
        env: { PATH: '/usr/bin:/bin', HOME: f.root, WORKFORCE_NODE: f.node },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.cwd, f.repo);
      assert.deepEqual(receipt.args, ['--no-open', 'argument with spaces']);
      assert.equal(receipt.path.split(path.delimiter)[0], f.nodeDir);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('run.sh skips an unusable explicit Node and finds a usable Node on PATH', () => {
  const f = wrapperFixture();
  try {
    const rejectedNode = path.join(f.root, 'outdated-node');
    writeFileSync(rejectedNode, '#!/bin/sh\nexit 1\n');
    chmodSync(rejectedNode, 0o755);
    const result = spawnSync('/bin/sh', [path.join(f.repo, 'run.sh'), '--no-open'], {
      cwd: f.outside,
      env: { PATH: `${f.nodeDir}:/usr/bin:/bin`, HOME: f.root, WORKFORCE_NODE: rejectedNode },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).cwd, f.repo);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the Finder command preserves a failed launch exit status after showing its close prompt', () => {
  const f = wrapperFixture();
  try {
    writeFileSync(path.join(f.repo, 'run.sh'), '#!/bin/sh\nexit 7\n');
    const result = spawnSync('/bin/sh', [path.join(f.repo, 'Run Workforce.command')], {
      cwd: f.outside, env: { PATH: '/usr/bin:/bin' }, input: '\n', encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Press Return to close/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('runWorkspace opens the verified URL only after startup is ready', async () => {
  let ready;
  const startup = new Promise(resolve => { ready = resolve; });
  const opened = [];
  const messages = [];
  const result = { action: 'started', url: 'http://127.0.0.1:4499' };
  const pending = runWorkspace({ ensure: () => startup, open: async url => { opened.push(url); }, write: text => messages.push(text) });
  await Promise.resolve();
  assert.deepEqual(opened, []);
  assert.equal(messages.some(message => message.includes('is ready')), false);
  ready(result);
  assert.equal(await pending, result);
  assert.deepEqual(opened, [result.url]);
  assert.ok(messages.some(message => message.includes('Frontend and backend started together')));
});

test('runWorkspace no-open still ensures readiness and reports reuse without opening a browser', async () => {
  let ensured = 0;
  let opened = 0;
  const messages = [];
  const result = { action: 'reused', url: 'http://127.0.0.1:4499' };
  assert.equal(await runWorkspace({
    noOpen: true,
    ensure: async () => { ensured++; return result; },
    open: async () => { opened++; },
    write: text => messages.push(text),
  }), result);
  assert.equal(ensured, 1);
  assert.equal(opened, 0);
  assert.ok(messages.some(message => message.includes('Using your existing running workspace')));
});

test('runWorkspace does not open a browser or claim readiness after a startup failure', async () => {
  const failure = new Error('Workspace did not become ready');
  const messages = [];
  let opened = 0;
  await assert.rejects(runWorkspace({
    ensure: async () => { throw failure; },
    open: async () => { opened++; },
    write: text => messages.push(text),
  }), error => error === failure);
  assert.equal(opened, 0);
  assert.equal(messages.some(message => message.includes('is ready')), false);
});

test('runWorkspace keeps a ready workspace available when the browser opener fails', async () => {
  const result = { action: 'started', url: 'http://127.0.0.1:4499' };
  const messages = [];
  assert.equal(await runWorkspace({
    ensure: async () => result,
    open: async () => { throw new Error('No browser installed'); },
    write: text => messages.push(text),
  }), result);
  assert.ok(messages.some(message => message.includes(`Open ${result.url} in your browser`)));
});
