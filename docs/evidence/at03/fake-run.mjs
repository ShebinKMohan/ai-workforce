/**
 * AT03 supplementary driver: the same coordinator entry point `workforce run`
 * uses, with an agent bound to the deterministic fake runtime and a scenario
 * selected through the session environment (the CLI has no flag for it).
 *
 * argv: <repo> <agents.json> <state-dir> <task-file> <scenario-file> <agent-id>
 */
import { commandRun } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/commands/run.js';
import { Reporter } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/output.js';

const [repo, agents, stateDir, taskFile, scenario, agent] = process.argv.slice(2);
const reporter = new Reporter(false, process);
let exitCode;
try {
  const result = await commandRun(
    { repo, agents, agent, stateDir, taskFile, json: false },
    { reporter, streams: process, sessionEnv: { WORKFORCE_FAKE_SCENARIO: scenario } },
  );
  exitCode = reporter.result(result);
} catch (error) {
  reporter.diagnostic(`error: ${error?.message ?? String(error)}`);
  for (const detail of error?.details ?? []) reporter.diagnostic(`  ${detail}`);
  exitCode = error?.exitCode ?? 4;
}
process.exitCode = exitCode;
