/**
 * Honest timing (FR060 foundation): dispatch, startup, runtime, validation
 * and integration time are measured separately and never summed into a
 * single "speed" number. Usage that cannot be observed is reported as
 * unavailable, never as zero.
 */
import { monotonicNowMs } from '../core/ids.js';

export const PHASES = ['dispatch', 'startup', 'runtime', 'validation', 'integration'] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseTiming {
  readonly totalMs: number;
  readonly samples: number;
  /** True while a span for this phase is still open. */
  readonly open: boolean;
}

export interface TimingSummary {
  readonly phases: Readonly<Record<Phase, PhaseTiming>>;
  /** Wall time between the first span start and the last span end (or now if still open). */
  readonly elapsedMs: number;
}

export type UsageStatus = 'measured' | 'estimated' | 'unavailable';

export interface UsageReport {
  readonly status: UsageStatus;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly source: string;
}

export const USAGE_UNAVAILABLE: UsageReport = { status: 'unavailable', inputTokens: null, outputTokens: null, costUsd: null, source: 'not reported by runtime' };

export interface PhaseSpan {
  readonly phase: Phase;
  end(): number;
}

export class PhaseTimer {
  readonly #clock: () => number;
  readonly #totals = new Map<Phase, { totalMs: number; samples: number; openSince: number | null }>();
  #firstStart: number | null = null;
  #lastEnd: number | null = null;

  constructor(clock: () => number = monotonicNowMs) {
    this.#clock = clock;
    for (const phase of PHASES) this.#totals.set(phase, { totalMs: 0, samples: 0, openSince: null });
  }

  /** Begin a span. A phase can have only one open span; beginning it again is an error. */
  begin(phase: Phase): PhaseSpan {
    const entry = this.#totals.get(phase)!;
    if (entry.openSince !== null) throw new Error(`phase ${phase} already has an open span`);
    const start = this.#clock();
    entry.openSince = start;
    if (this.#firstStart === null) this.#firstStart = start;
    let ended = false;
    return {
      phase,
      end: () => {
        if (ended) throw new Error(`phase ${phase} span already ended`);
        ended = true;
        const stop = this.#clock();
        entry.totalMs += Math.max(0, stop - start);
        entry.samples += 1;
        entry.openSince = null;
        this.#lastEnd = stop;
        return stop - start;
      },
    };
  }

  /** Time an async operation under a phase. */
  async measure<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    const span = this.begin(phase);
    try {
      return await fn();
    } finally {
      span.end();
    }
  }

  summary(): TimingSummary {
    const now = this.#clock();
    const phases = {} as Record<Phase, PhaseTiming>;
    for (const phase of PHASES) {
      const entry = this.#totals.get(phase)!;
      const openMs = entry.openSince === null ? 0 : Math.max(0, now - entry.openSince);
      phases[phase] = { totalMs: entry.totalMs + openMs, samples: entry.samples, open: entry.openSince !== null };
    }
    const end = this.#lastEnd ?? now;
    const anyOpen = PHASES.some((p) => phases[p].open);
    const elapsedMs = this.#firstStart === null ? 0 : Math.max(0, (anyOpen ? now : end) - this.#firstStart);
    return { phases, elapsedMs };
  }
}

export function formatTiming(summary: TimingSummary): string {
  const parts = PHASES.map((phase) => {
    const timing = summary.phases[phase];
    return `${phase} ${Math.round(timing.totalMs)}ms${timing.open ? ' (open)' : ''}`;
  });
  return `${parts.join(' · ')} · elapsed ${Math.round(summary.elapsedMs)}ms`;
}
