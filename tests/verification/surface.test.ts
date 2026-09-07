/**
 * The acceptance surface, including the escape it exists to close: a
 * repository whose acceptance suite lives outside every conventional test
 * path. Rewriting that suite has to count as a fixture mutation, or a worker
 * can manufacture a pass by replacing the thing that judges it.
 */
import { describe, expect, it } from 'vitest';
import { acceptanceSurface, findSurfaceChanges } from '../../src/verification/surface.js';
import type { CheckSpec } from '../../src/verification/checks.js';

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
