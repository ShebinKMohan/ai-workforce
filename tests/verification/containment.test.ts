import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareStateRootFingerprints,
  ContainmentError,
  createVerificationRoot,
  findEnclosingStateRoot,
  fingerprintStateRoot,
  isDisjoint,
  looksLikeStateRoot,
  resolveStateRoot,
  VERIFICATION_ROOT_ENV,
} from '../../src/verification/containment.js';
import { createStatePaths, isWithin } from '../../src/storage/paths.js';
import { openStateStore } from '../../src/storage/db.js';
import { openTempState } from '../helpers/state.js';
import { cleanupAll, registerCleanup, tempDir } from '../workspaces/support.js';

afterEach(() => cleanupAll());

/** A real coordinator state root: manifest, runs/, workspaces/, state.sqlite and the lock files. */
function stateRoot(): string {
  const state = openTempState();
  registerCleanup(() => state.cleanup());
  return state.root;
}

describe('findEnclosingStateRoot', () => {
  it('finds the state root from a run\'s own output directory', () => {
    const root = stateRoot();
    const outputRoot = path.join(root, 'runs', 'run-1', 'verification', 'attempt-1');
    mkdirSync(outputRoot, { recursive: true });
    expect(findEnclosingStateRoot(outputRoot)).toBe(root);
    expect(looksLikeStateRoot(root)).toBe(true);
  });

  it('returns null for a directory that is not inside any state root', () => {
    const unrelated = tempDir('workforce-unrelated-');
    expect(findEnclosingStateRoot(unrelated)).toBeNull();
    // A lookalike without the manifest is not a state root either.
    mkdirSync(path.join(unrelated, 'runs'), { recursive: true });
    mkdirSync(path.join(unrelated, 'workspaces'), { recursive: true });
    expect(looksLikeStateRoot(unrelated)).toBe(false);
  });

  it('identifies a state root whose workspaces live outside it (--workspace-root)', () => {
    // The configuration that used to switch the guard off: with the workspace
    // root elsewhere, `ensureStateRoot` never creates `workspaces/`, so a test
    // for that directory's existence answered "not a state root" about the very
    // directory holding state.sqlite, the lock and every run artifact.
    const outsideWorkspaces = tempDir('workforce-elsewhere-ws-');
    const root = tempDir('workforce-split-state-');
    const paths = createStatePaths(root, { workspaceRoot: outsideWorkspaces });
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    expect(existsSync(path.join(paths.root, 'workspaces'))).toBe(false);
    expect(looksLikeStateRoot(paths.root)).toBe(true);
    const outputRoot = path.join(paths.root, 'runs', 'run-1', 'verification');
    mkdirSync(outputRoot, { recursive: true });
    expect(findEnclosingStateRoot(outputRoot)).toBe(paths.root);
  });

  it('does not mistake a copy of another root\'s manifest for a state root', () => {
    const root = stateRoot();
    const impostor = tempDir('workforce-impostor-');
    mkdirSync(path.join(impostor, 'runs'), { recursive: true });
    writeFileSync(path.join(impostor, 'manifest.json'), readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    // The manifest names the other directory as the state root, so this one is
    // identified by what it says about itself, not by the files it holds.
    expect(looksLikeStateRoot(impostor)).toBe(false);
  });
});

describe('resolveStateRoot decides what the guard protects', () => {
  it('guards the root the coordinator names, rather than inferring one', () => {
    const root = stateRoot();
    const resolution = resolveStateRoot({ declared: root, outputRoot: tempDir('workforce-elsewhere-') });
    expect(resolution).toMatchObject({ root, origin: 'declared', undetermined: false });
    expect(resolution.note).toContain('paths manifest identifies it as one');
  });

  it('falls back to searching upwards only when no caller names one', () => {
    const root = stateRoot();
    const outputRoot = path.join(root, 'runs', 'run-1', 'verification');
    mkdirSync(outputRoot, { recursive: true });
    expect(resolveStateRoot({ outputRoot })).toMatchObject({ root, origin: 'discovered', undetermined: false });
  });

  it('says so, loudly, when a named state root cannot be established', () => {
    // Never "nothing to guard": something is wrong with what the coordinator
    // said, and a guard that quietly compares nothing reads like a clean one.
    const missing = path.join(tempDir('workforce-missing-'), 'no-such-state-root');
    const resolution = resolveStateRoot({ declared: missing, outputRoot: tempDir('workforce-out-') });
    expect(resolution).toMatchObject({ root: null, origin: 'undetermined', undetermined: true });
    expect(resolution.note).toContain('no such directory exists');
    expect(resolution.note).toContain('proves nothing about coordinator state');
  });

  it('reports an honest absence when there is genuinely nothing to guard', () => {
    expect(resolveStateRoot({ declared: null, outputRoot: tempDir('workforce-out2-') })).toMatchObject({
      root: null,
      origin: 'none',
      undetermined: false,
    });
    expect(resolveStateRoot({ outputRoot: tempDir('workforce-out3-') })).toMatchObject({ root: null, origin: 'none', undetermined: false });
  });
});

describe('createVerificationRoot keeps check execution out of the state root', () => {
  it('refuses a requested location inside the protected root and falls back to one outside it', () => {
    const root = stateRoot();
    const created = createVerificationRoot({ requested: path.join(root, 'runs', 'run-1', 'verification'), protect: [root] });
    registerCleanup(() => created.dispose());

    expect(isWithin(root, created.path)).toBe(false);
    expect(isDisjoint(root, created.path)).toBe(true);
    expect(existsSync(created.path)).toBe(true);
    expect(created.origin).toBe('os_temp');
    expect(created.diagnostics.join(' ')).toContain('inside the protected root');
  });

  it('honours an explicit location that is outside the protected root', () => {
    const root = stateRoot();
    const elsewhere = tempDir('workforce-vroot-');
    const created = createVerificationRoot({ requested: elsewhere, protect: [root] });
    registerCleanup(() => created.dispose());
    expect(created.origin).toBe('requested');
    expect(isWithin(elsewhere, created.path)).toBe(true);
  });

  it('honours the environment override', () => {
    const elsewhere = tempDir('workforce-vroot-env-');
    process.env[VERIFICATION_ROOT_ENV] = elsewhere;
    registerCleanup(() => {
      delete process.env[VERIFICATION_ROOT_ENV];
    });
    const created = createVerificationRoot({ protect: [stateRoot()] });
    registerCleanup(() => created.dispose());
    expect(created.origin).toBe('environment');
    expect(isWithin(elsewhere, created.path)).toBe(true);
  });

  it('throws rather than placing untrusted code inside a protected root', () => {
    // Protecting the OS temp directory leaves no candidate at all.
    expect(() => createVerificationRoot({ requested: tempDir('workforce-vroot-'), protect: [os.tmpdir()] })).toThrow(ContainmentError);
    try {
      createVerificationRoot({ protect: [os.tmpdir()] });
      throw new Error('expected a ContainmentError');
    } catch (error) {
      expect((error as ContainmentError).code).toBe('no_safe_verification_root');
      expect((error as Error).message).toContain('no check runs rather than running it inside the state root');
    }
  });
});

describe('the state root guard detects a change the coordinator did not make', () => {
  it('reports a file dropped into the state root as a violation', () => {
    const root = stateRoot();
    const before = fingerprintStateRoot(root);
    writeFileSync(path.join(root, 'PWNED.txt'), 'owned');
    const report = compareStateRootFingerprints(before, fingerprintStateRoot(root));

    expect(report.checked).toBe(true);
    expect(report.violations).toContain('PWNED.txt (created)');
    expect(report.before).not.toBe(report.after);
    expect(report.note).toContain('changed while the check ran');
  });

  it('reports a modified manifest and a modified coordinator lock', () => {
    const root = stateRoot();
    const before = fingerprintStateRoot(root);
    writeFileSync(path.join(root, 'manifest.json'), '{"tampered":true}');
    writeFileSync(path.join(root, 'coordinator.lock'), 'not the real holder');
    const report = compareStateRootFingerprints(before, fingerprintStateRoot(root));
    expect(report.violations).toEqual(expect.arrayContaining(['manifest.json (modified)', 'coordinator.lock (modified)']));
  });

  it('reports a deleted or replaced database as a violation', () => {
    const root = stateRoot();
    const database = path.join(root, 'state.sqlite');
    const before = fingerprintStateRoot(root);
    const bytes = readFileSync(database);
    rmSync(database);
    writeFileSync(database, bytes);
    const report = compareStateRootFingerprints(before, fingerprintStateRoot(root));
    expect(report.violations.join(' ')).toContain('state.sqlite (replaced');
  });

  it('does not cry wolf over the writes the coordinator itself makes during a check', () => {
    const root = stateRoot();
    const before = fingerprintStateRoot(root);

    // A sibling task writing its own run artifacts, a worker writing in its
    // workspace, and SQLite appending to the database and its journal.
    mkdirSync(path.join(root, 'runs', 'run-2', 'artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'runs', 'run-2', 'events.jsonl'), '{"type":"run.started"}\n');
    mkdirSync(path.join(root, 'workspaces', 'run-2', 'task-a', 'attempt-1'), { recursive: true });
    writeFileSync(path.join(root, 'workspaces', 'run-2', 'task-a', 'attempt-1', 'file.txt'), 'worker output');
    writeFileSync(path.join(root, 'state.sqlite'), readFileSync(path.join(root, 'state.sqlite')));
    writeFileSync(path.join(root, 'state.sqlite-wal'), 'journal bytes');

    const report = compareStateRootFingerprints(before, fingerprintStateRoot(root));
    expect(report.violations).toEqual([]);
    expect(report.observations.length).toBeGreaterThan(0);
    expect(report.note).toContain('unchanged');
  });

  it('says plainly that it compared nothing when there is no state root', () => {
    const report = compareStateRootFingerprints(fingerprintStateRoot(null), fingerprintStateRoot(null));
    expect(report.checked).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.note).toContain('nothing was compared');
  });
});

describe('the guard follows the state root\'s own manifest', () => {
  it('prunes a workspace root the manifest puts somewhere other than workspaces/', () => {
    const root = stateRoot();
    // Rewrite the manifest the way `--workspace-root <state-root>/ws` would.
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const custom = path.join(root, 'ws');
    mkdirSync(custom, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, workspaceRoot: custom }, null, 2)}\n`);

    const before = fingerprintStateRoot(root);
    // A worker writing in its own workspace while a sibling task verifies.
    mkdirSync(path.join(custom, 'run-1', 'task-a', 'attempt-1'), { recursive: true });
    writeFileSync(path.join(custom, 'run-1', 'task-a', 'attempt-1', 'edited.ts'), 'worker output');
    const report = compareStateRootFingerprints(before, fingerprintStateRoot(root));

    expect(report.violations).toEqual([]);
    // The declared workspace root is still watched for deletion or replacement.
    expect(report.observations.some((entry) => entry.startsWith('ws ('))).toBe(true);
  });
});
