/**
 * The shared adapter conformance suite (plan section 6, FR010 foundation).
 *
 * These tests exercise the *contract*, not any one runtime. Everything they
 * assert is written in the language of `RuntimeAdapter`: readiness shape,
 * capability statuses, session identity, one active turn per session,
 * normalized event kinds with a monotonic sequence and raw references,
 * tolerance of unknown and malformed output, and receipts that distinguish
 * queued from submitted, requested from observed, and what was requested from
 * what was observed to have stopped.
 *
 * The suite runs against the deterministic fake adapter on every `npm test`,
 * and against the two real runtimes when `WORKFORCE_REAL_RUNTIMES=1`. It is the
 * evidence that the contract is provider-neutral: the Codex adapter drives a
 * JSON-RPC app server, the Claude Code adapter drives a CLI's newline-delimited
 * stdio, and neither shape shows through here.
 *
 * A capability a target cannot exercise is registered as an explicit skip with
 * its reason, never quietly dropped: a skipped check is not a passing check.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterId } from '../../../src/core/contracts.js';
import { RUNTIME_EVENT_KINDS, RuntimeEventSchema, type RuntimeAdapter, type RuntimeEvent, type SessionHandle } from '../../../src/adapters/types.js';

export interface ConformanceSession {
  readonly adapter: RuntimeAdapter;
  readonly handle: SessionHandle;
  readonly workspace: string;
  close(): Promise<void>;
}

export interface ConformanceTarget {
  /** Name used in the test titles. */
  readonly name: string;
  readonly adapterId: AdapterId;
  /** The version the target's capability statuses must name; null when the adapter states none. */
  readonly expectedTestedVersion: string | null;
  /** Executable to probe passively. Omit, with a reason, when there is nothing to probe. */
  readonly probeExecutable?: string;
  readonly probeSkipReason?: string;
  /** Prompt for the quick turn. Keep it tiny: real targets spend a real quota. */
  readonly prompt: string;
  /** Open a session whose turn reaches a terminal event on its own. */
  openQuick(): Promise<ConformanceSession>;
  /** Open a session whose turn stays open until it is interrupted, plus the prompt that does it. */
  openSlow?: (() => Promise<ConformanceSession>) | undefined;
  readonly slowPrompt?: string | undefined;
  readonly slowSkipReason?: string | undefined;
  /** Open a session whose stream carries unknown record types and malformed lines. */
  openNoisy?: (() => Promise<ConformanceSession>) | undefined;
  readonly noisySkipReason?: string | undefined;
}

async function drain(adapter: RuntimeAdapter, session: ConformanceSession, prompt: string): Promise<RuntimeEvent[]> {
  const turn = await adapter.startTurn(session.handle, { prompt });
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.events(turn)) events.push(event);
  return events;
}

function isTerminal(event: RuntimeEvent): boolean {
  return event.kind === 'turn_completed' || event.kind === 'turn_interrupted' || (event.kind === 'error' && event.payload['fatal'] === true);
}

export function runConformanceSuite(target: ConformanceTarget): void {
  describe(`adapter conformance: ${target.name}`, () => {
    // -----------------------------------------------------------------------
    // Readiness and capabilities
    // -----------------------------------------------------------------------

    if (target.probeExecutable === undefined) {
      it.skip(`probe: skipped — ${target.probeSkipReason ?? 'no executable to probe'}`, () => undefined);
    } else {
      it('probe returns a readiness report that never assumes readiness', async () => {
        const session = await target.openQuick();
        try {
          const readiness = await session.adapter.probe(target.probeExecutable!);
          expect(readiness.adapter).toBe(target.adapterId);
          expect(readiness.executablePath).toBe(target.probeExecutable);
          expect(['unknown', 'not_ready', 'verified_ready']).toContain(readiness.ready);
          expect(['unknown', 'logged_in', 'logged_out', 'not_required']).toContain(readiness.authentication);
          expect(readiness.probeKind).toBe('passive');
          // Readiness is never an assumption: `verified_ready` requires both an
          // observed control path and a settled authentication state. A runtime
          // whose login state is unknown can never be ready (plan section 6,
          // rule 4).
          if (readiness.ready === 'verified_ready') {
            expect(readiness.controllable, 'ready implies controllable').toBe(true);
            expect(['logged_in', 'not_required'], 'ready implies a settled authentication state').toContain(readiness.authentication);
          }
          if (readiness.authentication === 'unknown') expect(readiness.ready).not.toBe('verified_ready');
          expect(Date.parse(readiness.observedAt)).not.toBeNaN();
          expect(Array.isArray(readiness.diagnostics)).toBe(true);
        } finally {
          await session.close();
        }
      });
    }

    it('every capability status is one of the three legal values and names the version it was tested against', async () => {
      const session = await target.openQuick();
      try {
        const capabilities = session.adapter.capabilities();
        expect(capabilities.adapter).toBe(target.adapterId);
        const names = Object.keys(capabilities.capabilities);
        expect(names.length).toBeGreaterThan(0);
        for (const [name, report] of Object.entries(capabilities.capabilities)) {
          expect(['unsupported', 'supported_unverified', 'verified'], `${name} status`).toContain(report.status);
          // A status that claims anything must say what it was established against.
          if (report.status !== 'unsupported') {
            expect(report.testedVersion, `${name} testedVersion`).not.toBeNull();
            expect(report.os, `${name} os`).not.toBeNull();
          }
          if (target.expectedTestedVersion !== null && report.testedVersion !== null) {
            expect(report.testedVersion, `${name} testedVersion`).toBe(target.expectedTestedVersion);
          }
        }
        // Offered settings carry a provenance, never a bare string.
        for (const offered of [...capabilities.settings.model.offered, ...capabilities.settings.effort.offered]) {
          expect(['reported', 'configured']).toContain(offered.provenance);
        }
      } finally {
        await session.close();
      }
    });

    it('validateSettings refuses a value the adapter cannot honour rather than mapping it', async () => {
      const session = await target.openQuick();
      try {
        const validation = session.adapter.validateSettings({ effort: 'definitely-not-a-real-effort-level' });
        expect(validation.adapter).toBe(target.adapterId);
        expect(['supported_unverified', 'unsupported']).toContain(validation.effort.status);
        if (validation.effort.status === 'unsupported') expect(validation.ok).toBe(false);
        // Nothing is ever reported as `supported` that was not offered.
        expect(validation.effort.status).not.toBe('supported');
      } finally {
        await session.close();
      }
    });

    // -----------------------------------------------------------------------
    // Session identity and turn ownership
    // -----------------------------------------------------------------------

    it('session identity is known before the first event and stays stable', async () => {
      const session = await target.openQuick();
      try {
        const { handle } = session;
        expect(handle.adapter).toBe(target.adapterId);
        expect(handle.sessionId.length).toBeGreaterThan(0);
        // Known before any turn has run.
        const before = await session.adapter.reconcile(handle);
        expect(before.sessionId).toBe(handle.sessionId);
        expect(before.activeTurnId).toBeNull();

        const events = await drain(session.adapter, session, target.prompt);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.sessionId === handle.sessionId)).toBe(true);

        const after = await session.adapter.reconcile(handle);
        expect(after.sessionId).toBe(handle.sessionId);
      } finally {
        await session.close();
      }
    });

    it('a session records a process identity that is more than a reusable pid', async () => {
      const session = await target.openQuick();
      try {
        const identity = session.handle.process;
        expect(identity, 'the handle carries a process identity').not.toBeNull();
        expect(identity!.pid).toBeGreaterThan(0);
        expect(identity!.spawnToken.length).toBeGreaterThanOrEqual(8);
      } finally {
        await session.close();
      }
    });

    if (target.openSlow === undefined) {
      it.skip(`one active turn per session: skipped — ${target.slowSkipReason ?? 'no long-running turn available'}`, () => undefined);
    } else {
      it('refuses a second turn while one is active', async () => {
        const session = await target.openSlow!();
        try {
          await session.adapter.startTurn(session.handle, { prompt: target.slowPrompt ?? target.prompt });
          await expect(session.adapter.startTurn(session.handle, { prompt: 'second' })).rejects.toThrow();
        } finally {
          await session.close();
        }
      });
    }

    // -----------------------------------------------------------------------
    // Event normalization
    // -----------------------------------------------------------------------

    it('normalizes into the documented event kinds, monotonically, with raw references', async () => {
      const session = await target.openQuick();
      try {
        const events = await drain(session.adapter, session, target.prompt);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          // The schema is strict: an adapter that invents a field fails here.
          expect(() => RuntimeEventSchema.parse(event)).not.toThrow();
          expect(RUNTIME_EVENT_KINDS).toContain(event.kind);
          expect(event.adapter).toBe(target.adapterId);
          expect(event.rawRef.length).toBeGreaterThan(0);
          expect(event.spawnToken.length).toBeGreaterThan(0);
          expect(Date.parse(event.timestamp)).not.toBeNaN();
        }
        // Sequence is monotonic per process instance.
        const bySpawn = new Map<string, number[]>();
        for (const event of events) {
          const list = bySpawn.get(event.spawnToken) ?? [];
          list.push(event.sequence);
          bySpawn.set(event.spawnToken, list);
        }
        for (const [token, sequences] of bySpawn) {
          for (let i = 1; i < sequences.length; i += 1) expect(sequences[i], `sequence for spawn ${token}`).toBeGreaterThan(sequences[i - 1]!);
        }
        // The stream ends on a terminal event and nothing follows it.
        const terminalIndex = events.findIndex(isTerminal);
        expect(terminalIndex, 'the stream reached a terminal event').toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBe(events.length - 1);
      } finally {
        await session.close();
      }
    });

    it('nothing a runtime says can end a turn as accepted (FR050)', async () => {
      const session = await target.openQuick();
      try {
        const events = await drain(session.adapter, session, target.prompt);
        // The contract has no event kind that means "accepted"; that word
        // belongs to the verifier, and the enum has no room for it.
        expect(RUNTIME_EVENT_KINDS).not.toContain('accepted' as never);
        // An assistant message is never terminal, however confidently it claims
        // to be finished; only a turn_* event (or a fatal error) ends a stream.
        for (const event of events.filter((e) => e.kind === 'assistant_message')) expect(isTerminal(event)).toBe(false);
        const terminal = events.find(isTerminal)!;
        expect(['turn_completed', 'turn_interrupted', 'error']).toContain(terminal.kind);
        // No adapter may smuggle an acceptance into a payload.
        for (const event of events) {
          expect(Object.keys(event.payload), `${event.kind} payload`).not.toContain('accepted');
        }
      } finally {
        await session.close();
      }
    });

    if (target.openNoisy === undefined) {
      it.skip(`unknown and malformed output: skipped — ${target.noisySkipReason ?? 'this target cannot be made to emit malformed output'}`, () => undefined);
    } else {
      it('unknown record types and malformed lines never break the stream', async () => {
        const session = await target.openNoisy!();
        try {
          const events = await drain(session.adapter, session, target.prompt);
          // It still reached a terminal event...
          expect(events.some(isTerminal)).toBe(true);
          // ...and kept the unparseable material as `raw` evidence instead of dropping it.
          expect(events.some((e) => e.kind === 'raw')).toBe(true);
          for (const event of events) expect(() => RuntimeEventSchema.parse(event)).not.toThrow();
        } finally {
          await session.close();
        }
      });
    }

    // -----------------------------------------------------------------------
    // Receipts
    // -----------------------------------------------------------------------

    it('a delivery with no active turn is queued, not claimed as submitted', async () => {
      const session = await target.openQuick();
      try {
        const receipt = await session.adapter.deliver(session.handle, { messageId: 'conformance-1', body: 'a peer message' });
        expect(receipt.messageId).toBe('conformance-1');
        expect(receipt.state).toBe('queued');
        expect(receipt.turnId).toBeNull();
        expect(Date.parse(receipt.at)).not.toBeNaN();
      } finally {
        await session.close();
      }
    });

    if (target.openSlow === undefined) {
      it.skip(`delivery into an active turn: skipped — ${target.slowSkipReason ?? 'no long-running turn available'}`, () => undefined);
    } else {
      it('a delivery during an active turn names the turn it was submitted to, or says it was only queued', async () => {
        const session = await target.openSlow!();
        try {
          const turn = await session.adapter.startTurn(session.handle, { prompt: target.slowPrompt ?? target.prompt });
          const receipt = await session.adapter.deliver(session.handle, { messageId: 'conformance-2', body: 'a peer message' });
          if (receipt.state === 'submitted_to_active_turn') {
            expect(receipt.turnId, 'a submitted receipt names the turn').toBe(turn.turnId);
          } else {
            expect(receipt.state).toBe('queued');
            expect(receipt.turnId, 'a queued receipt names no turn').toBeNull();
          }
          await session.adapter.interrupt(turn);
        } finally {
          await session.close();
        }
      });

      it('an interrupt receipt says observed only when the turn actually ended', async () => {
        const session = await target.openSlow!();
        try {
          const turn = await session.adapter.startTurn(session.handle, { prompt: target.slowPrompt ?? target.prompt });
          const collected: RuntimeEvent[] = [];
          const reading = (async () => {
            for await (const event of session.adapter.events(turn)) collected.push(event);
          })();
          const receipt = await session.adapter.interrupt(turn);
          expect(['requested', 'observed']).toContain(receipt.state);
          expect(receipt.turnId).toBe(turn.turnId);
          if (receipt.state === 'observed') {
            await reading;
            const terminal = collected.filter((e) => e.turnId === turn.turnId && isTerminal(e));
            expect(terminal.length, 'an observed interruption has a terminal event behind it').toBeGreaterThan(0);
          }
        } finally {
          await session.close();
        }
      });
    }

    // -----------------------------------------------------------------------
    // Stopping and reconciliation
    // -----------------------------------------------------------------------

    it('reconcile reports process liveness, and a stop receipt reports what was observed', async () => {
      const session = await target.openQuick();
      let closed = false;
      try {
        const before = await session.adapter.reconcile(session.handle);
        expect(['boolean', 'string']).toContain(typeof before.processAlive);
        expect(before.processAlive).toBe(true);
        expect(before.processIdentityStatus).toBe('alive');
        expect(before.lastEventSequence).toBeGreaterThanOrEqual(0);

        const receipt = await session.adapter.stopOwnedProcesses(session.handle);
        closed = true;
        expect(['requested', 'process_tree_terminated', 'unknown']).toContain(receipt.state);
        expect(receipt.sessionId).toBe(session.handle.sessionId);

        const after = await session.adapter.reconcile(session.handle);
        if (receipt.state === 'process_tree_terminated') {
          expect(after.processAlive, 'a terminated tree is not alive').toBe(false);
          expect(after.processGroupAlive).toBe(false);
        }
        expect(after.activeTurnId).toBeNull();
      } finally {
        if (!closed) await session.close();
      }
    });

    it('never signals a process it can only identify by a bare pid', async () => {
      const session = await target.openQuick();
      try {
        const receipt = await session.adapter.stopOwnedProcesses({ adapter: target.adapterId, sessionId: 'a-session-this-adapter-never-opened', processId: 999_999, raw: null });
        expect(receipt.state).toBe('unknown');
        expect(receipt.signal).toBeNull();
      } finally {
        await session.close();
      }
    });
  });
}
