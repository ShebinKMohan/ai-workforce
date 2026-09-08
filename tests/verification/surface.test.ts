/**
 * The acceptance surface, including the escape it exists to close: a
 * repository whose acceptance suite lives outside every conventional test
 * path. Rewriting that suite has to count as a fixture mutation, or a worker
 * can manufacture a pass by replacing the thing that judges it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acceptanceSurface, findSurfaceChanges, resolveAcceptanceSurface, surfaceBlockers, surfaceDependencyPaths, surfacePaths } from '../../src/verification/surface.js';
import type { CheckSpec } from '../../src/verification/checks.js';

describe('the surface module is reviewable text', () => {
  it('contains no control bytes, so git, grep and file can all read it', () => {
    // Two literal NUL bytes used as map-key separators made this module binary
    // to every tool anyone would review it with. A separator has to be spelled
    // as an escape, not embedded.
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/verification/surface.ts'), 'utf8');
    // eslint-disable-next-line no-control-regex
    const offending = [...source].filter((ch) => ch !== '\n' && ch !== '\t' && ch.charCodeAt(0) < 0x20);
    expect(offending).toEqual([]);
  });
});

const PACKAGE_CHECK: CheckSpec = { criterionId: 'package-test-script', command: 'npm', args: ['test', '--silent'], required: true };

describe('acceptance surface', () => {
  it('resolves the files a package.json test script executes, wherever they live', () => {
    const baseFiles = ['package.json', 'src/lib.js', 'verify/acceptance.js'];
    const manifest = JSON.stringify({ scripts: { test: 'node verify/acceptance.js' } });
    const surface = acceptanceSurface([PACKAGE_CHECK], baseFiles, { packageManifest: manifest });
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json', 'verify/acceptance.js']);

    const findings = findSurfaceChanges(surface, [{ status: 'M', path: 'verify/acceptance.js' }]);
    expect(findings.mutations).toEqual([{ criterionId: 'package-test-script', changedPaths: ['M verify/acceptance.js'] }]);
  });

  it('follows an npm run chain to the script that does the work', () => {
    const baseFiles = ['package.json', 'checks/all.js', 'src/lib.js'];
    const manifest = JSON.stringify({ scripts: { test: 'npm run verify', verify: 'node checks/all.js' } });
    const surface = acceptanceSurface([PACKAGE_CHECK], baseFiles, { packageManifest: manifest });
    expect(surface.byCriterion.get('package-test-script')).toContain('checks/all.js');
  });

  it('does not loop on a script that calls itself', () => {
    const manifest = JSON.stringify({ scripts: { test: 'npm run test' } });
    const surface = acceptanceSurface([PACKAGE_CHECK], ['package.json'], { packageManifest: manifest });
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json']);
  });

  it('still treats a new file inside the surface as an addition, not a mutation', () => {
    const baseFiles = ['package.json', 'verify/acceptance.js'];
    const manifest = JSON.stringify({ scripts: { test: 'node verify/acceptance.js' } });
    const surface = acceptanceSurface([PACKAGE_CHECK], baseFiles, { packageManifest: manifest });
    const findings = findSurfaceChanges(surface, [{ status: 'A', path: 'verify/extra.js' }]);
    expect(findings.mutations).toEqual([]);
  });

  it('ignores a script token that names nothing in the tree', () => {
    const manifest = JSON.stringify({ scripts: { test: 'node ../outside/thing.js && rm -rf /' } });
    const surface = acceptanceSurface([PACKAGE_CHECK], ['package.json'], { packageManifest: manifest });
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json']);
  });
});

/**
 * The module graph: what a criterion executes is what its entry points import,
 * transitively, at the base revision. A path-name rule cannot see any of this,
 * which is exactly why gutting an imported helper used to earn an "accepted".
 */
describe('the acceptance surface follows the module graph', () => {
  /** A base revision as a map of path to content, and the reader the surface takes. */
  function tree(files: Record<string, string>): { baseFiles: string[]; readBaseFile: (p: string) => Promise<string | null> } {
    return {
      baseFiles: Object.keys(files).sort(),
      readBaseFile: (p: string) => Promise.resolve(files[p] ?? null),
    };
  }

  const NODE_CHECK: CheckSpec = { criterionId: 'suite', command: 'node', args: ['verify/run.js'], required: true };

  it('protects a helper the acceptance suite imports, and does not protect the code under test', async () => {
    const files = tree({
      'package.json': JSON.stringify({ scripts: { test: 'node verify/run.js' } }),
      'verify/run.js': "import { expectEqual } from './expect.js';\nimport { total } from '../src/total.js';\nexpectEqual(total([1, 2]), 3, 'sums');\n",
      'verify/expect.js': 'export function expectEqual(a, b, what) { if (a !== b) throw new Error(what); }\n',
      'src/total.js': 'export function total(values) { return 0; }\n',
    });
    const surface = await resolveAcceptanceSurface([PACKAGE_CHECK], files.baseFiles, {
      packageManifest: files.baseFiles.includes('package.json') ? (await files.readBaseFile('package.json')) : null,
      readBaseFile: files.readBaseFile,
    });

    // The helper is reached only through the import; nothing about its path says "test".
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json', 'verify/expect.js', 'verify/run.js']);
    // The code under test is executed too, and is deliberately left writable.
    expect(surface.dependenciesByCriterion.get('package-test-script')).toEqual(['src/total.js']);

    const attack = findSurfaceChanges(surface, [{ status: 'M', path: 'verify/expect.js' }]);
    expect(attack.mutations).toEqual([{ criterionId: 'package-test-script', changedPaths: ['M verify/expect.js'] }]);

    const fix = findSurfaceChanges(surface, [{ status: 'M', path: 'src/total.js' }]);
    expect(fix.mutations).toEqual([]);
    expect(fix.dependencyChanges).toEqual([{ criterionId: 'package-test-script', changedPaths: ['M src/total.js'] }]);
  });

  it('does not forbid a source module just because a conventional test file imports it', async () => {
    const files = tree({
      'test/pagination.test.js': "import { pageCount } from '../src/pagination.js';\n",
      'src/pagination.js': 'export function pageCount() { return 0; }\n',
      'src/helpers.js': 'export const noop = () => {};\n',
    });
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfacePaths(surface)).toEqual(['test', 'test/pagination.test.js']);
    expect(surfaceDependencyPaths(surface)).toEqual(['src/pagination.js']);
    expect(findSurfaceChanges(surface, [{ status: 'M', path: 'src/pagination.js' }]).mutations).toEqual([]);
  });

  it('follows require(), dynamic import() and index resolution', async () => {
    const files = tree({
      'verify/run.js': "const { check } = require('./support');\nconst later = () => import('./cases/first.js');\ncheck(later);\n",
      'verify/support/index.js': "module.exports = { check: () => {} };\n",
      'verify/cases/first.js': 'export const first = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/cases/first.js', 'verify/run.js', 'verify/support/index.js']);
    expect(surface.resolution.unresolved).toEqual([]);
  });

  it('resolves a TypeScript ESM specifier that names the emitted .js file', async () => {
    const files = tree({
      'verify/run.ts': "import { expectEqual } from './expect.js';\nexpectEqual(1, 1);\n",
      'verify/expect.ts': 'export function expectEqual(a: number, b: number): void { if (a !== b) throw new Error("no"); }\n',
    });
    const check: CheckSpec = { criterionId: 'suite', command: 'tsx', args: ['verify/run.ts'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/expect.ts', 'verify/run.ts']);
  });

  it('ignores bare package specifiers and does not report them as gaps', async () => {
    const files = tree({
      'verify/run.js': "import assert from 'node:assert/strict';\nimport chalk from 'chalk';\nassert.ok(chalk);\n",
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/run.js']);
    expect(surface.resolution.unresolved).toEqual([]);
    expect(surface.resolution.truncated).toBe(false);
  });

  it('takes the whole directory a computed specifier loads from, rather than giving up on it', async () => {
    const files = tree({
      'verify/run.js': "const name = process.env.CASE;\nconst mod = await import(`./cases/${name}.js`);\nmod.run();\n",
      'verify/cases/one.js': 'export function run() {}\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    // Which case it loads is unknowable; that they all live in `./cases` is
    // not, and every one of them is a file the criterion may execute.
    expect(surface.byCriterion.get('suite')).toEqual(['verify/cases/one.js', 'verify/run.js']);
    expect(surface.resolution.unresolved).toEqual([]);
    expect(surface.resolution.gaps).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('still refuses to guess when a computed specifier has no literal prefix at all', async () => {
    const files = tree({
      'verify/run.js': "const mod = await import(process.env.HELPER);\nmod.run();\n",
      'verify/cases/one.js': 'export function run() {}\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.resolution.unresolved.join(' ')).toContain('loads a computed specifier');
    expect(surface.resolution.gaps).toEqual([
      { criterionId: 'suite', kind: 'computed_specifier', detail: 'verify/run.js loads a computed specifier (import(process.env.HELPER)); what it executes was not resolved' },
    ]);
    // The file it would have loaded is not silently claimed as protected...
    expect(surface.byCriterion.get('suite')).toEqual(['verify/run.js']);
    // ... and the gap refuses acceptance instead of being noted beside a pass.
    expect(surfaceBlockers(surface)).toHaveLength(1);
    expect(surfaceBlockers(surface)[0]).toContain('criterion "suite" could not be fully resolved');
    expect(surfaceBlockers(surface)[0]).toContain('make the specifier literal');
  });

  it('reports an entry point it cannot parse, such as a shell script that execs something else', async () => {
    const files = tree({
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/acceptance.sh' } }),
      'scripts/acceptance.sh': '#!/usr/bin/env bash\nexec node verify/run.js\n',
      'verify/run.js': 'console.log("ok");\n',
    });
    const surface = await resolveAcceptanceSurface([PACKAGE_CHECK], files.baseFiles, {
      packageManifest: await files.readBaseFile('package.json'),
      readBaseFile: files.readBaseFile,
    });

    // The script names its runner outright, so the criterion's surface reaches
    // it: `sh run.sh` must not protect less than `node run.js` would.
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json', 'scripts/acceptance.sh', 'verify/run.js']);
    expect(surface.resolution.unresolved).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('refuses when a shell entry point names nothing this repository contains', async () => {
    const files = tree({
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/acceptance.sh' } }),
      'scripts/acceptance.sh': '#!/usr/bin/env bash\nexec "$RUNNER" --all\n',
      'verify/run.js': 'console.log("ok");\n',
    });
    const surface = await resolveAcceptanceSurface([PACKAGE_CHECK], files.baseFiles, {
      packageManifest: await files.readBaseFile('package.json'),
      readBaseFile: files.readBaseFile,
    });

    expect(surface.resolution.unresolved.join(' ')).toContain('no literal command in it names a file of this repository');
    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json', 'scripts/acceptance.sh']);
    expect(surfaceBlockers(surface)[0]).toContain('criterion "package-test-script" could not be fully resolved');
  });

  it('follows a symlink to the module it points at, instead of reading its link text as source', async () => {
    // `git show <rev>:<path>` hands back a symlink's TARGET PATH, not the file.
    // Read as source it has no imports, so before this the real helper never
    // entered the surface at all — and nothing said so.
    const files = tree({
      'verify/run.js': "import { expectEqual } from './expect.js';\nimport { total } from '../src/total.js';\nexpectEqual(total([1, 2]), 3, 'sums');\n",
      'verify/expect.js': 'real/expect-impl.js',
      'verify/real/expect-impl.js': 'export function expectEqual(a, b, what) { if (a !== b) throw new Error(what); }\n',
      'src/total.js': 'export function total(values) { return 0; }\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/expect.js', 'verify/real/expect-impl.js', 'verify/run.js']);
    expect(surface.dependenciesByCriterion.get('suite')).toEqual(['src/total.js']);
    expect(surface.resolution.unresolved).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('does not mistake an ordinary one-line module for a symlink', async () => {
    const files = tree({
      'verify/run.js': "export * from './helper.js';\n",
      'verify/helper.js': 'export const helper = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    // The re-export was parsed as an import, not swallowed as link text.
    expect(surface.byCriterion.get('suite')).toEqual(['verify/helper.js', 'verify/run.js']);
    expect(surface.resolution.unresolved).toEqual([]);
  });

  it('takes a check whose command is itself a repository script as an entry point', async () => {
    const files = tree({
      'verify/check.sh': '#!/bin/sh\nexec node verify/run.js\n',
      'verify/run.js': "import { expectEqual } from './expect.js';\nexpectEqual(1, 1, 'ok');\n",
      'verify/expect.js': 'export function expectEqual(a, b, what) { if (a !== b) throw new Error(what); }\n',
    });
    const surface = await resolveAcceptanceSurface([{ criterionId: 'suite', command: './verify/check.sh', required: true }], files.baseFiles, {
      readBaseFile: files.readBaseFile,
    });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/check.sh', 'verify/expect.js', 'verify/run.js']);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('does not read source quoted inside a string literal as a module reference', async () => {
    // A repository's own tests quote code as data. Treating those quotations
    // as imports invents files the criterion never executes and — now that an
    // unresolved reference refuses — would refuse a repository on the strength
    // of a fixture string.
    const files = tree({
      'verify/run.js': [
        "const SAMPLE = \"import { thing } from './nowhere.js';\";",
        "const DYNAMIC = 'const m = await import(process.env.WHATEVER);';",
        "import { real } from './real.js';",
        'console.log(SAMPLE, DYNAMIC, real);',
        '',
      ].join('\n'),
      'verify/real.js': 'export const real = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    // The real import was followed; neither quotation was.
    expect(surface.byCriterion.get('suite')).toEqual(['verify/real.js', 'verify/run.js']);
    expect(surface.resolution.gaps).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('reports a relative import that resolves to nothing at the base revision', async () => {
    const files = tree({ 'verify/run.js': "import './missing.js';\n" });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.resolution.unresolved.join(' ')).toContain('imports "./missing.js", which does not resolve to a file in the base revision');
  });

  it('turns a truncated walk into a labelled conservative surface rather than a refusal', async () => {
    // A cap is a fact about this walk, not about the repository. Refusing here
    // makes an ordinary-sized closure unverifiable, and a truncated analysis
    // that says it is truncated is more useful than a run that cannot happen.
    const files = tree({
      'verify/run.js': "import './a.js';\n",
      'verify/a.js': "import './b.js';\n",
      'verify/b.js': "import './c.js';\n",
      'verify/c.js': 'export const c = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile, limits: { maxFiles: 2 } });

    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.resolution.gaps).toEqual([]);
    // It is still said, in the criterion's own name, and marked conservative.
    expect(surface.resolution.conservative).toBe(true);
    expect(surface.resolution.truncated).toBe(true);
    expect(surface.resolution.limitations).toEqual([
      { criterionId: 'suite', kind: 'analysis_truncated', detail: 'the import walk stopped after 2 files; files beyond that cap are NOT part of this surface' },
    ]);
    expect(surface.resolution.unresolved.join(' ')).toContain('the import walk stopped after 2 files');
  });

  it('does not reach the default caps on a closure of a size a real repository has', async () => {
    // The old caps refused a correct run at 400 files in a closure and at 200
    // module files under a directory a check names. Both are ordinary sizes.
    const files: Record<string, string> = { 'verify/run.js': '' };
    const imports: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      files[`verify/cases/case-${index}.js`] = `export const value = ${index};\n`;
      imports.push(`import { value as v${index} } from './cases/case-${index}.js';`);
    }
    files['verify/run.js'] = `${imports.join('\n')}\n`;
    const built = tree(files);
    const surface = await resolveAcceptanceSurface([NODE_CHECK], built.baseFiles, { readBaseFile: built.readBaseFile });

    expect(surface.resolution.truncated).toBe(false);
    expect(surface.resolution.conservative).toBe(false);
    expect(surface.resolution.limitations).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.byCriterion.get('suite')).toHaveLength(601);
  });

  it('does not reach the directory cap on a directory a check names', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 500; index += 1) files[`test/case-${index}.test.js`] = `export const value = ${index};\n`;
    const built = tree(files);
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], required: true };
    const surface = await resolveAcceptanceSurface([check], built.baseFiles, { readBaseFile: built.readBaseFile });

    expect(surface.resolution.truncated).toBe(false);
    expect(surface.resolution.limitations).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
  });

  it('blocks the caller that follows no module graph at all, rather than reporting a clean surface', () => {
    const surface = acceptanceSurface([PACKAGE_CHECK], ['package.json', 'verify/acceptance.js'], {
      packageManifest: JSON.stringify({ scripts: { test: 'node verify/acceptance.js' } }),
    });

    expect(surface.resolution.gaps).toEqual([
      {
        criterionId: '*',
        kind: 'no_reader',
        detail:
          'the acceptance surface was resolved from path patterns and command arguments only: this caller did not follow the module graph, so the modules those files import are NOT covered',
      },
    ]);
    expect(surfaceBlockers(surface)[0]).toContain('the acceptance surface for every criterion could not be fully resolved, so no criterion is established');
  });

  it('names one blocker per criterion, so a reader sees which criteria are unprovable', async () => {
    const files = tree({
      'verify/one.js': 'const m = await import(process.env.A);\nm.run();\n',
      'verify/two.js': 'const m = await import(process.env.B);\nm.run();\n',
    });
    const surface = await resolveAcceptanceSurface(
      [
        { criterionId: 'first', command: 'node', args: ['verify/one.js'], required: true },
        { criterionId: 'second', command: 'node', args: ['verify/two.js'], required: true },
      ],
      files.baseFiles,
      { readBaseFile: files.readBaseFile },
    );

    const blockers = surfaceBlockers(surface);
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toContain('criterion "first"');
    expect(blockers[1]).toContain('criterion "second"');
  });

  it('says the surface is partial when the walk hits its cap, rather than returning a short list quietly', async () => {
    const files = tree({
      'verify/run.js': "import './a.js';\n",
      'verify/a.js': "import './b.js';\n",
      'verify/b.js': "import './c.js';\n",
      'verify/c.js': 'export const c = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile, limits: { maxFiles: 2 } });

    expect(surface.resolution.truncated).toBe(true);
    expect(surface.resolution.unresolved.join(' ')).toContain('the import walk stopped after 2 files');
    expect(surface.byCriterion.get('suite')!.length).toBeLessThan(4);
  });

  it('stops at the depth cap and names where it stopped', async () => {
    const files = tree({
      'verify/run.js': "import './a.js';\n",
      'verify/a.js': "import './b.js';\n",
      'verify/b.js': 'export const b = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile, limits: { maxDepth: 1 } });

    expect(surface.resolution.truncated).toBe(true);
    expect(surface.resolution.unresolved.join(' ')).toContain('depth cap 1 reached');
    expect(surface.byCriterion.get('suite')).toEqual(['verify/a.js', 'verify/run.js']);
  });

  it('terminates on an import cycle', async () => {
    const files = tree({
      'verify/run.js': "import './a.js';\n",
      'verify/a.js': "import './b.js';\n",
      'verify/b.js': "import './a.js';\nimport './run.js';\n",
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/a.js', 'verify/b.js', 'verify/run.js']);
    expect(surface.resolution.truncated).toBe(false);
  });

  it('does not follow imports in commented-out code', async () => {
    const files = tree({
      'verify/run.js': "// import './old.js';\n/* import './older.js'; */\nimport './current.js';\n",
      'verify/old.js': 'export const old = 1;\n',
      'verify/older.js': 'export const older = 1;\n',
      'verify/current.js': 'export const current = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/current.js', 'verify/run.js']);
  });

  it('follows Python imports, absolute against the repository and relative against the file', async () => {
    const files = tree({
      'tests/__init__.py': '',
      'tests/test_ranges.py': 'import unittest\n\nfrom src.ranges import chunk\nfrom .helpers import build\n',
      'tests/helpers.py': 'def build():\n    return []\n',
      'src/__init__.py': '',
      'src/ranges.py': 'def chunk(values, size):\n    return []\n',
    });
    const check: CheckSpec = { criterionId: 'python-unittest', command: 'python3', args: ['-m', 'unittest', 'discover', '-v'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    // `tests/` is conventional, so its files are shared across criteria.
    expect(surface.byCriterion.get('*')).toEqual(['tests/__init__.py', 'tests/helpers.py', 'tests/test_ranges.py']);
    // The module under test is executed, and stays writable.
    expect(surface.dependenciesByCriterion.get('*')).toEqual(['src/__init__.py', 'src/ranges.py']);
    expect(surface.resolution.unresolved).toEqual([]);
  });

  it('protects a helper whose own name says test support even outside the suite directory', async () => {
    const files = tree({
      'test/billing.test.js': "import { expectInvoice } from '../harness/expect-invoice.js';\nimport { total } from '../src/total.js';\nexpectInvoice(total([1]), 1);\n",
      'harness/expect-invoice.js': 'export function expectInvoice(a, b) { if (a !== b) throw new Error("no"); }\n',
      'src/total.js': 'export function total() { return 0; }\n',
    });
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfacePaths(surface)).toEqual(['harness/expect-invoice.js', 'test', 'test/billing.test.js']);
    expect(surfaceDependencyPaths(surface)).toEqual(['src/total.js']);
  });

  it('does not report a data file under a test path as an unresolved gap', async () => {
    const files = tree({
      'test/cases.json': '[{"total": 3}]\n',
      'test/billing.test.js': "import { total } from '../src/total.js';\ntotal([1, 2]);\n",
      'src/total.js': 'export function total() { return 0; }\n',
    });
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    // The JSON file is pinned by its path, and it is not a gap in the walk.
    expect(surface.byCriterion.get('*')).toEqual(['test/billing.test.js', 'test/cases.json']);
    expect(surface.resolution.unresolved).toEqual([]);
  });

  it('says so when it was given no way to read the base revision', async () => {
    const files = tree({ 'verify/run.js': "import './expect.js';\n", 'verify/expect.js': 'export const e = 1;\n' });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, {});

    expect(surface.resolution.moduleGraphResolved).toBe(false);
    expect(surface.resolution.truncated).toBe(true);
    expect(surface.resolution.unresolved.join(' ')).toContain('no reader for the base revision was supplied');
    // ... and the helper it could not see is absent rather than wrongly listed as covered.
    expect(surface.byCriterion.get('suite')).toEqual(['verify/run.js']);
  });

  it('keeps the synchronous surface working for callers that cannot read the base, and marks it partial', () => {
    const surface = acceptanceSurface([PACKAGE_CHECK], ['package.json', 'verify/acceptance.js'], {
      packageManifest: JSON.stringify({ scripts: { test: 'node verify/acceptance.js' } }),
    });

    expect(surface.byCriterion.get('package-test-script')).toEqual(['package.json', 'verify/acceptance.js']);
    expect(surface.resolution.moduleGraphResolved).toBe(false);
    expect(surface.resolution.truncated).toBe(true);
  });
});

/**
 * Languages the walk cannot read.
 *
 * The module graph closed the gutted-helper hole for JavaScript, TypeScript
 * and Python, and then refused everything else: a Go, Rust, C, Ruby or Swift
 * repository has no import graph this walk can follow, so every criterion was
 * unresolved and no run could ever be accepted. That is not a safety property,
 * it is an outage. The answer is a CONSERVATIVE surface that says what it did
 * not prove, and a way for the operator to prove it.
 */
describe('a repository in a language the walk cannot read', () => {
  function tree(files: Record<string, string>): { baseFiles: string[]; readBaseFile: (p: string) => Promise<string | null> } {
    return { baseFiles: Object.keys(files).sort(), readBaseFile: (p: string) => Promise.resolve(files[p] ?? null) };
  }

  const GO_FILES = {
    'go.mod': 'module example.com/billing\n\ngo 1.22\n',
    'internal/billing/total.go': 'package billing\n\nfunc Total(amounts []int) int {\n\treturn 0\n}\n',
    'internal/billing/total_test.go': 'package billing\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {}\n',
  };

  it('resolves a conservative surface instead of refusing every criterion', async () => {
    const files = tree(GO_FILES);
    const check: CheckSpec = { criterionId: 'go-tests', command: 'go', args: ['test', './internal/billing'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    // The run can happen at all. That is the whole point.
    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.resolution.gaps).toEqual([]);
    // And it is labelled, in the criterion's own name, with the residual risk.
    expect(surface.resolution.conservative).toBe(true);
    expect(surface.resolution.limitations).toHaveLength(1);
    expect(surface.resolution.limitations[0]!.criterionId).toBe('go-tests');
    expect(surface.resolution.limitations[0]!.kind).toBe('language_unsupported');
    expect(surface.resolution.limitations[0]!.detail).toContain('contain no JavaScript, TypeScript or Python module');
    expect(surface.resolution.limitations[0]!.detail).toContain('closure was NOT proven');
    expect(surface.resolution.limitations[0]!.detail).toContain('"fixtures"');
    // What can be identified without parsing is still protected: Go's own
    // `_test.go` convention is as load-bearing as `.test.js` is here, so
    // rewriting the suite is still a mutation...
    expect(surfacePaths(surface)).toEqual(['internal/billing/total_test.go']);
    expect(findSurfaceChanges(surface, [{ status: 'M', path: 'internal/billing/total_test.go' }]).mutations).toEqual([
      // Shared, because `_test.go` is a fixture path whatever the check is, and
      // named for this criterion, because its check runs that package.
      { criterionId: '*', changedPaths: ['M internal/billing/total_test.go'] },
      { criterionId: 'go-tests', changedPaths: ['M internal/billing/total_test.go'] },
    ]);
    // ... and the code under test, which shares the package directory the
    // check names, stays writable. Protecting that directory wholesale would
    // forbid the one file the task exists to change.
    expect(findSurfaceChanges(surface, [{ status: 'M', path: 'internal/billing/total.go' }]).mutations).toEqual([]);
  });

  it('still protects a named directory whole when it holds modules this walk CAN read', async () => {
    // The narrowing above exists only for a directory the walk cannot analyse.
    // Where it can, the closure is followed from the modules inside, and
    // narrowing the protected path would stop protecting the data beside them.
    const files = tree({
      'verify/run.js': "import './expect.js';\n",
      'verify/expect.js': 'export const e = 1;\n',
      'verify/cases.json': '[{"total": 60}]\n',
    });
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'verify/'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfacePaths(surface)).toContain('verify');
    expect(findSurfaceChanges(surface, [{ status: 'M', path: 'verify/cases.json' }]).mutations).toEqual([
      { criterionId: 'node-tests', changedPaths: ['M verify/cases.json'] },
    ]);
  });

  it('is upgraded to an established surface when the operator names the fixtures', async () => {
    const files = tree(GO_FILES);
    const check: CheckSpec = {
      criterionId: 'go-tests',
      command: 'go',
      args: ['test', './internal/billing'],
      fixtures: ['internal/billing/total_test.go'],
      required: true,
    };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.resolution.limitations).toEqual([]);
    expect(surface.resolution.conservative).toBe(false);
    expect(surface.resolution.gaps).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surfacePaths(surface)).toEqual(['internal/billing/total_test.go']);
    expect(findSurfaceChanges(surface, [{ status: 'M', path: 'internal/billing/total.go' }]).mutations).toEqual([]);
  });

  it('refuses a declared fixture the base revision does not contain, rather than reading a typo as a declaration', async () => {
    const files = tree(GO_FILES);
    const check: CheckSpec = { criterionId: 'go-tests', command: 'go', args: ['test', './internal/billing'], fixtures: ['internal/billing/totals_test.go'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.resolution.gaps).toEqual([
      {
        criterionId: 'go-tests',
        kind: 'declared_fixture_missing',
        detail:
          'this criterion declares the fixture path(s) internal/billing/totals_test.go in .workforce/checks.json, and the base revision contains no such path, so the closure they were meant to declare is not established',
      },
    ]);
    expect(surfaceBlockers(surface)[0]).toContain('correct the "fixtures" paths');
  });

  it('names a criterion whose command matches nothing at all, rather than reporting an empty surface as a clean one', async () => {
    // Rust keeps its unit tests inside the module they test, so there is no
    // test-named file and no conventional directory: nothing at all can be
    // identified without parsing, and the run must say exactly that.
    const files = tree({
      'Cargo.toml': '[package]\nname = "billing"\n',
      'src/lib.rs': 'pub fn total(amounts: &[i64]) -> i64 {\n    0\n}\n\n#[cfg(test)]\nmod tests {}\n',
    });
    const check: CheckSpec = { criterionId: 'cargo-tests', command: 'cargo', args: ['test'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.resolution.conservative).toBe(true);
    expect(surface.resolution.limitations[0]!.kind).toBe('external_toolchain');
    expect(surface.resolution.limitations[0]!.detail).toContain('names no path this repository contains');
  });

  it('treats a shell entry point that runs an external toolchain as a limitation, not a refusal', async () => {
    const files = tree({
      ...GO_FILES,
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/acceptance.sh' } }),
      'scripts/acceptance.sh': '#!/usr/bin/env bash\nset -e\ngo test ./...\n',
    });
    const surface = await resolveAcceptanceSurface([PACKAGE_CHECK], files.baseFiles, {
      packageManifest: await files.readBaseFile('package.json'),
      readBaseFile: files.readBaseFile,
    });

    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.resolution.limitations.some((limitation) => limitation.kind === 'external_toolchain')).toBe(true);
    expect(surface.resolution.limitations.map((limitation) => limitation.detail).join(' ')).toContain('runs an external toolchain this walk cannot analyse');
    // The script itself is still pinned: rewriting it still replaces the criterion.
    expect(surfacePaths(surface)).toContain('scripts/acceptance.sh');
  });

  it('still refuses a shell entry point whose runner is computed, because nothing bounds what it runs', async () => {
    const files = tree({
      'package.json': JSON.stringify({ scripts: { test: 'bash scripts/acceptance.sh' } }),
      'scripts/acceptance.sh': '#!/usr/bin/env bash\nexec "$RUNNER" --all\n',
      'verify/run.js': 'console.log("ok");\n',
    });
    const surface = await resolveAcceptanceSurface([PACKAGE_CHECK], files.baseFiles, {
      packageManifest: await files.readBaseFile('package.json'),
      readBaseFile: files.readBaseFile,
    });

    expect(surface.resolution.gaps.map((gap) => gap.kind)).toEqual(['entry_not_module']);
    expect(surfaceBlockers(surface)[0]).toContain('criterion "package-test-script" could not be fully resolved');
  });
});

/**
 * One unresolvable import used to block every criterion in the repository,
 * including when it sat in a fixture no check runs. A gap belongs to the
 * criterion whose evidence it undermines, and to no other.
 */
describe('a gap belongs to the criterion that executes the file it came from', () => {
  function tree(files: Record<string, string>): { baseFiles: string[]; readBaseFile: (p: string) => Promise<string | null> } {
    return { baseFiles: Object.keys(files).sort(), readBaseFile: (p: string) => Promise.resolve(files[p] ?? null) };
  }

  const FILES = {
    'test/legacy/retired.test.js': "import { gone } from './gone.js';\ngone();\n",
    'test/current/pagination.test.js': "import { pageCount } from '../../src/pagination.js';\npageCount(1, 1);\n",
    'src/pagination.js': 'export function pageCount() { return 0; }\n',
  };

  it('does not let a file no criterion executes block anything', async () => {
    const files = tree(FILES);
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test/current'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    // The broken import is real and is reported...
    expect(surface.resolution.unresolved.join(' ')).toContain('test/legacy/retired.test.js imports "./gone.js"');
    // ... as a limitation about a file the criterion never runs, not a blocker.
    expect(surface.resolution.gaps).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surface.resolution.limitations.some((limitation) => limitation.kind === 'unexecuted_fixture')).toBe(true);
  });

  it('still refuses, in that criterion\'s name, when the criterion does execute the file', async () => {
    const files = tree(FILES);
    const check: CheckSpec = { criterionId: 'node-tests', command: 'node', args: ['--test', 'test'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    const blockers = surfaceBlockers(surface);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('criterion "node-tests"');
    expect(blockers[0]).toContain('test/legacy/retired.test.js imports "./gone.js"');
    // Never as `*`: "every criterion" is a claim about the whole repository.
    expect(surface.resolution.gaps.every((gap) => gap.criterionId === 'node-tests')).toBe(true);
  });

  it('gives the shared closure to a criterion that names no entry point of its own', async () => {
    // `pytest` with no argument discovers whatever the conventions hold, so a
    // broken import in that closure really does undermine its evidence.
    const files = tree({
      'tests/test_ranges.py': 'from .missing import helper\n',
      'src/ranges.py': 'def chunk(values, size):\n    return []\n',
    });
    const check: CheckSpec = { criterionId: 'pytest', command: 'pytest', args: ['-q'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfaceBlockers(surface)).toHaveLength(1);
    expect(surfaceBlockers(surface)[0]).toContain('criterion "pytest"');
  });
});

/**
 * Comment stripping used to be a regex over raw source. A string literal
 * holding a glob (`'cases/*'`) opened a block comment that ran to the next
 * `*` + `/`, and every import in between vanished from the surface — which is
 * a FALSE ACCEPT, not a false refusal: the walk reported a clean closure for
 * files it never read.
 */
describe('comment stripping knows what a string is', () => {
  function tree(files: Record<string, string>): { baseFiles: string[]; readBaseFile: (p: string) => Promise<string | null> } {
    return { baseFiles: Object.keys(files).sort(), readBaseFile: (p: string) => Promise.resolve(files[p] ?? null) };
  }
  const NODE_CHECK: CheckSpec = { criterionId: 'suite', command: 'node', args: ['verify/run.js'], required: true };

  it('does not let a glob in a string literal swallow the imports after it', async () => {
    const files = tree({
      'verify/run.js': ["const CASES = 'cases/*';", "import { expectEqual } from './expect.js';", "const SOURCES = 'src/*/index.js';", 'expectEqual(CASES, SOURCES);', ''].join('\n'),
      'verify/expect.js': 'export function expectEqual(a, b) { if (a !== b) throw new Error("no"); }\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/expect.js', 'verify/run.js']);
    expect(surface.resolution.gaps).toEqual([]);
  });

  it('handles the same glob in a template literal and in double quotes', async () => {
    const files = tree({
      'verify/run.js': ['const CASES = `cases/*`;', "import { expectEqual } from './expect.js';", 'const MORE = "src/*/index.js";', 'expectEqual(CASES, MORE);', ''].join('\n'),
      'verify/expect.js': 'export function expectEqual(a, b) { if (a !== b) throw new Error("no"); }\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/expect.js', 'verify/run.js']);
  });

  it('does not let a regular-expression literal containing a comment opener swallow an import', async () => {
    const files = tree({
      'verify/run.js': ['const BLOCK = /[/*]/;', "import { expectEqual } from './expect.js';", 'const CLOSE = /[*/]/;', 'expectEqual(BLOCK.source, CLOSE.source);', ''].join('\n'),
      'verify/expect.js': 'export function expectEqual(a, b) { if (a !== b) throw new Error("no"); }\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/expect.js', 'verify/run.js']);
  });

  it('still strips a real comment, including one that trails live code', async () => {
    const files = tree({
      'verify/run.js': ["import './current.js'; // import './trailing.js';", "/* import './block.js'; */", "// import './line.js';", ''].join('\n'),
      'verify/current.js': 'export const current = 1;\n',
      'verify/trailing.js': 'export const trailing = 1;\n',
      'verify/block.js': 'export const block = 1;\n',
      'verify/line.js': 'export const line = 1;\n',
    });
    const surface = await resolveAcceptanceSurface([NODE_CHECK], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.byCriterion.get('suite')).toEqual(['verify/current.js', 'verify/run.js']);
  });

  it('does not read a Python docstring as a set of imports the module makes', async () => {
    const files = tree({
      'tests/test_ranges.py': ['"""Usage:', '', 'from .retired import helper', '"""', 'from src.ranges import chunk', '', 'def test_chunk():', '    assert chunk([], 1) == []', ''].join('\n'),
      'src/ranges.py': 'def chunk(values, size):\n    return []\n',
    });
    const check: CheckSpec = { criterionId: 'pytest', command: 'pytest', args: ['-q'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surface.resolution.unresolved).toEqual([]);
    expect(surfaceBlockers(surface)).toEqual([]);
    expect(surfaceDependencyPaths(surface)).toEqual(['src/ranges.py']);
  });

  it('does not treat a "#" inside a Python string as the start of a comment', async () => {
    const files = tree({
      'tests/test_ranges.py': ['ANCHOR = "http://example.com/#top"', 'from src.ranges import chunk', '', 'def test_chunk():', '    assert chunk([], 1) == []', ''].join('\n'),
      'src/ranges.py': 'def chunk(values, size):\n    return []\n',
    });
    const check: CheckSpec = { criterionId: 'pytest', command: 'pytest', args: ['-q'], required: true };
    const surface = await resolveAcceptanceSurface([check], files.baseFiles, { readBaseFile: files.readBaseFile });

    expect(surfaceDependencyPaths(surface)).toEqual(['src/ranges.py']);
    expect(surface.resolution.unresolved).toEqual([]);
  });
});
