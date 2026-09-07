/**
 * The shared conformance suite, run against every adapter implementation.
 *
 * Deterministic targets (the fake runtime and the Claude Code adapter driven by
 * its recorded-replay binary) run on every `npm test`. The two installed
 * runtimes run only under `WORKFORCE_REAL_RUNTIMES=1`, and are reported as
 * explicit skips otherwise — a skipped check is not a passing check.
 */
import { describe, it } from 'vitest';
import { runConformanceSuite } from './suite.js';
import { claudeReplayTarget, fakeTarget, realClaudeTarget, realCodexTarget } from './targets.js';

const REAL = process.env['WORKFORCE_REAL_RUNTIMES'] === '1';
const CODEX_PATH = process.env['WORKFORCE_CODEX_PATH'] ?? '/opt/homebrew/bin/codex';
const CLAUDE_PATH = process.env['WORKFORCE_CLAUDE_PATH'] ?? `${process.env['HOME'] ?? ''}/.local/bin/claude`;
/**
 * This machine's ~/.codex/config.toml defaults to a model the installed CLI
 * rejects with HTTP 400, so the conformance run pins one from `model/list`.
 */
const CODEX_MODEL = process.env['WORKFORCE_CODEX_MODEL'] ?? 'gpt-5.6-sol';

runConformanceSuite(fakeTarget);
runConformanceSuite(claudeReplayTarget);

if (REAL) {
  runConformanceSuite(realClaudeTarget(CLAUDE_PATH));
  runConformanceSuite(realCodexTarget(CODEX_PATH, CODEX_MODEL));
} else {
  describe('adapter conformance: installed runtimes', () => {
    it.skip('skipped — set WORKFORCE_REAL_RUNTIMES=1 to run the suite against the installed codex and claude executables', () => undefined);
  });
}
