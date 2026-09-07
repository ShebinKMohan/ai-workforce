/**
 * `--plan <file>`: the only way to hand the planned orchestrator a task graph.
 *
 * `decomposeRequest` deliberately invents no dependencies, so before this
 * existed `PlannedTaskInput.dependencies` was unreachable from the shipped
 * product and dependency scheduling could not be exercised at all.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPlanFile } from '../../src/cli/commands/run.js';
import { CliError } from '../../src/cli/output.js';
import { tempDir } from '../helpers/state.js';

function planFile(contents: unknown): string {
  const file = path.join(tempDir('workforce-plan-'), 'plan.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe('the plan file', () => {
  it('carries dependencies through to the planned orchestrator', () => {
    const file = planFile({
      tasks: [
        { key: 'fast', objective: 'Produce the interface the other task needs.' },
        { key: 'slow', objective: 'Consume it.', dependencies: ['fast'] },
      ],
    });
    expect(readPlanFile(file)).toEqual([
      { key: 'fast', objective: 'Produce the interface the other task needs.' },
      { key: 'slow', objective: 'Consume it.', dependencies: ['fast'] },
    ]);
  });

  it('keeps a per-task agent and writer flag', () => {
    const file = planFile({ tasks: [{ key: 'read', objective: 'Survey the code.', agentId: 'architect', writer: false }] });
    expect(readPlanFile(file)).toEqual([{ key: 'read', objective: 'Survey the code.', agentId: 'architect', writer: false }]);
  });

  it('refuses a malformed plan before anything is run', () => {
    const file = planFile({ tasks: [{ objective: 'no key' }] });
    expect(() => readPlanFile(file)).toThrow(CliError);
  });

  it('refuses a file that is not JSON', () => {
    const file = path.join(tempDir('workforce-plan-bad-'), 'plan.json');
    writeFileSync(file, 'tasks: not json');
    expect(() => readPlanFile(file)).toThrow(/not valid JSON/);
  });
});
