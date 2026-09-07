/**
 * AT03 supplementary driver: run the SAME task through the SAME coordinator
 * (`commandRun`, exactly what `workforce run` calls) and the SAME real
 * ClaudeCodeAdapter — but with the adapter's executable pointed at the
 * deterministic recorded-replay binary (fixtures/claude-code/fake-claude.mjs)
 * instead of the installed `claude`.
 *
 * This exists because the installed claude 2.1.260 on this machine holds no
 * usable credential: every model turn ends in ~60 ms with
 * "authentication_failed". Nothing here is a model turn, and nothing here is
 * evidence that Claude Code fixed the bug. It is evidence that the coordinator
 * plus the claude-code adapter reach `accepted` on this task through the same
 * code path the Codex run used.
 *
 * argv: <repo> <agents.json> <state-dir> <task-file> <scenario-file> <vars-json>
 */
import { readFileSync } from 'node:fs';
import { commandRun } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/commands/run.js';
import { Reporter } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/output.js';
import { ClaudeCodeAdapter } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/adapters/claude-code/adapter.js';

const [repo, agents, stateDir, taskFile, scenario, varsJson] = process.argv.slice(2);
const REPLAY = '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/fake-claude.mjs';

const reporter = new Reporter(false, process);
let exitCode;
try {
  const result = await commandRun(
    {
      repo,
      agents,
      agent: 'engineer-claude',
      stateDir,
      taskFile,
      allowUnconfinedWrites: true,
      json: false,
    },
    {
      reporter,
      streams: process,
      // The real WP05 adapter. Only its executable is the replay binary.
      adapterFactory: (_runtime, context) =>
        new ClaudeCodeAdapter({
          executablePath: process.execPath,
          extraArgs: [REPLAY],
          logsDir: context.logsDir,
          startupTimeoutMs: 20_000,
          controlTimeoutMs: 20_000,
          stopTimeoutMs: 5_000,
        }),
      sessionEnv: {
        WORKFORCE_FAKE_CLAUDE_SCENARIO: scenario,
        WORKFORCE_FAKE_CLAUDE_VARS: varsJson ?? '{}',
      },
    },
  );
  exitCode = reporter.result(result);
} catch (error) {
  reporter.diagnostic(`error: ${error?.message ?? String(error)}`);
  for (const detail of error?.details ?? []) reporter.diagnostic(`  ${detail}`);
  exitCode = error?.exitCode ?? 4;
}
process.exitCode = exitCode;
