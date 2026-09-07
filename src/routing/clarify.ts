/**
 * Clarification gate (FR023).
 *
 * A question costs the user their attention, which is the thing this product
 * exists to save. So a question is warranted only when both hold:
 *
 *   1. the answer materially changes the result — there are at least two
 *      concretely different outcomes and the difference blocks acceptance or
 *      changes the deliverable; and
 *   2. the repository cannot answer it — every probe that could have answered
 *      it was tried and came back empty.
 *
 * Questions and answers are recorded durably through a `ClarificationJournal`
 * (the event log in production, memory in tests) so a restarted coordinator
 * still knows what was asked. Work that does not depend on the answer keeps
 * running: `partitionOnClarification` names exactly which tasks are blocked.
 */

export type ClarificationImpact = 'blocks_acceptance' | 'changes_deliverable' | 'cosmetic' | 'none';

export interface ClarificationCandidate {
  readonly id: string;
  readonly question: string;
  readonly impact: ClarificationImpact;
  /** The concretely different results the answer would produce. Two or more, or the question is not material. */
  readonly divergentOutcomes: ReadonlyArray<string>;
  /** Repository locations that could answer this without asking (paths, globs, config keys). */
  readonly repositoryProbes: ReadonlyArray<string>;
  /** Tasks that cannot proceed without the answer. Everything else continues. */
  readonly affectedTaskIds?: ReadonlyArray<string>;
}

export interface RepositoryAnswer {
  readonly found: boolean;
  readonly answer?: string;
  /** Where the answer was found, so the decision is checkable. */
  readonly source?: string;
}

/** Injectable repository lookup, so the gate is testable without a repository. */
export interface RepositoryOracle {
  lookup(probe: string): RepositoryAnswer | Promise<RepositoryAnswer>;
}

export type ClarificationVerdict = 'warranted' | 'not_material' | 'answered_by_repository' | 'no_probe_attempted';

export interface ClarificationAssessment {
  readonly candidateId: string;
  readonly warranted: boolean;
  readonly verdict: ClarificationVerdict;
  readonly reason: string;
  readonly resolvedFromRepository?: { readonly probe: string; readonly answer: string; readonly source: string };
}

const MATERIAL_IMPACTS: ReadonlyArray<ClarificationImpact> = ['blocks_acceptance', 'changes_deliverable'];

/**
 * Decide whether a question is worth the user's attention. Never asks; only
 * decides. Probes are attempted in order and the first hit ends the assessment.
 */
export async function assessClarification(
  candidate: ClarificationCandidate,
  options: { readonly oracle: RepositoryOracle },
): Promise<ClarificationAssessment> {
  const distinct = new Set(candidate.divergentOutcomes.map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0));
  if (!MATERIAL_IMPACTS.includes(candidate.impact) || distinct.size < 2) {
    return {
      candidateId: candidate.id,
      warranted: false,
      verdict: 'not_material',
      reason:
        distinct.size < 2
          ? `the question names ${distinct.size} distinct outcome(s); an answer that does not change the result is not worth asking for`
          : `impact "${candidate.impact}" does not block acceptance or change the deliverable, so the work proceeds on the stated assumption`,
    };
  }

  if (candidate.repositoryProbes.length === 0) {
    return {
      candidateId: candidate.id,
      warranted: false,
      verdict: 'no_probe_attempted',
      reason: 'no repository probe was attempted; look in the repository before asking the user',
    };
  }

  for (const probe of candidate.repositoryProbes) {
    const result = await options.oracle.lookup(probe);
    if (result.found) {
      return {
        candidateId: candidate.id,
        warranted: false,
        verdict: 'answered_by_repository',
        reason: `the repository already answers this at ${result.source ?? probe}`,
        resolvedFromRepository: { probe, answer: result.answer ?? '', source: result.source ?? probe },
      };
    }
  }

  return {
    candidateId: candidate.id,
    warranted: true,
    verdict: 'warranted',
    reason: `the answer decides between ${distinct.size} different results and ${candidate.repositoryProbes.length} repository probe(s) found nothing`,
  };
}

// ---------------------------------------------------------------------------
// Durable record
// ---------------------------------------------------------------------------

export interface ClarificationRecord {
  readonly id: string;
  readonly runId: string;
  readonly question: string;
  readonly impact: ClarificationImpact;
  readonly divergentOutcomes: ReadonlyArray<string>;
  readonly affectedTaskIds: ReadonlyArray<string>;
  readonly askedAt: string;
  readonly answer: string | null;
  readonly answeredAt: string | null;
  readonly resolvedFrom: 'user' | 'repository' | null;
}

export interface ClarificationJournal {
  recordAsked(record: ClarificationRecord): Promise<void> | void;
  recordAnswered(id: string, answer: string, resolvedFrom: 'user' | 'repository', at: string): Promise<void> | void;
  list(): Promise<ReadonlyArray<ClarificationRecord>> | ReadonlyArray<ClarificationRecord>;
}

/** Minimal event-log sink, so this module never depends on a database handle. */
export interface ClarificationEventSink {
  append(input: {
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): void;
}

export const CLARIFICATION_ASKED_EVENT = 'clarification.asked';
export const CLARIFICATION_ANSWERED_EVENT = 'clarification.answered';

/**
 * Journal backed by the run event log. Idempotency keys make a replayed ask a
 * no-op, so a restart never duplicates a question.
 */
export function createEventJournal(sink: ClarificationEventSink, mirror?: ClarificationJournal): ClarificationJournal {
  const memory = mirror ?? createMemoryJournal();
  return {
    async recordAsked(record) {
      sink.append({
        type: CLARIFICATION_ASKED_EVENT,
        idempotencyKey: `clarification:asked:${record.id}`,
        payload: {
          clarificationId: record.id,
          question: record.question,
          impact: record.impact,
          divergentOutcomes: [...record.divergentOutcomes],
          affectedTaskIds: [...record.affectedTaskIds],
          askedAt: record.askedAt,
        },
      });
      await memory.recordAsked(record);
    },
    async recordAnswered(id, answer, resolvedFrom, at) {
      sink.append({
        type: CLARIFICATION_ANSWERED_EVENT,
        idempotencyKey: `clarification:answered:${id}`,
        payload: { clarificationId: id, answer, resolvedFrom, answeredAt: at },
      });
      await memory.recordAnswered(id, answer, resolvedFrom, at);
    },
    list: () => memory.list(),
  };
}

export function createMemoryJournal(): ClarificationJournal {
  const records = new Map<string, ClarificationRecord>();
  return {
    recordAsked(record) {
      if (!records.has(record.id)) records.set(record.id, record);
    },
    recordAnswered(id, answer, resolvedFrom, at) {
      const existing = records.get(id);
      if (existing === undefined) throw new Error(`no clarification "${id}" was recorded as asked; an answer cannot precede its question`);
      if (existing.answer !== null) return;
      records.set(id, { ...existing, answer, answeredAt: at, resolvedFrom });
    },
    list: () => [...records.values()],
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface ClarifyInput {
  readonly runId: string;
  readonly candidate: ClarificationCandidate;
  readonly oracle: RepositoryOracle;
  readonly journal: ClarificationJournal;
  readonly now?: () => string;
}

export interface ClarifyResult {
  readonly assessment: ClarificationAssessment;
  /** Present when the question was asked or resolved; null when it was not worth recording. */
  readonly record: ClarificationRecord | null;
}

/**
 * Assess, and record durably. A question answered by the repository is recorded
 * as asked and immediately answered from that source, so the reasoning survives
 * a restart and is never re-litigated.
 */
export async function clarify(input: ClarifyInput): Promise<ClarifyResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const assessment = await assessClarification(input.candidate, { oracle: input.oracle });
  if (assessment.verdict === 'not_material' || assessment.verdict === 'no_probe_attempted') {
    return { assessment, record: null };
  }

  const askedAt = now();
  const record: ClarificationRecord = {
    id: input.candidate.id,
    runId: input.runId,
    question: input.candidate.question,
    impact: input.candidate.impact,
    divergentOutcomes: [...input.candidate.divergentOutcomes],
    affectedTaskIds: [...(input.candidate.affectedTaskIds ?? [])],
    askedAt,
    answer: null,
    answeredAt: null,
    resolvedFrom: null,
  };
  await input.journal.recordAsked(record);

  if (assessment.verdict === 'answered_by_repository') {
    const answer = assessment.resolvedFromRepository?.answer ?? '';
    const at = now();
    await input.journal.recordAnswered(record.id, answer, 'repository', at);
    return { assessment, record: { ...record, answer, answeredAt: at, resolvedFrom: 'repository' } };
  }

  return { assessment, record };
}

/** Record the user's answer to a question that was asked. */
export async function answerClarification(
  journal: ClarificationJournal,
  id: string,
  answer: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await journal.recordAnswered(id, answer, 'user', now());
}

export interface ClarificationPartition {
  /** Tasks that cannot proceed until an outstanding question is answered. */
  readonly blocked: ReadonlyArray<string>;
  /** Everything else. Independent work continues while the user thinks. */
  readonly continuing: ReadonlyArray<string>;
  readonly openQuestionIds: ReadonlyArray<string>;
}

/**
 * Split a task set by outstanding questions. Only tasks a question explicitly
 * names are blocked; a question with no named tasks blocks nothing.
 */
export function partitionOnClarification(
  taskIds: ReadonlyArray<string>,
  records: ReadonlyArray<ClarificationRecord>,
): ClarificationPartition {
  const open = records.filter((r) => r.answer === null);
  const blockedSet = new Set<string>();
  for (const record of open) for (const id of record.affectedTaskIds) if (taskIds.includes(id)) blockedSet.add(id);
  return {
    blocked: taskIds.filter((id) => blockedSet.has(id)),
    continuing: taskIds.filter((id) => !blockedSet.has(id)),
    openQuestionIds: open.map((r) => r.id),
  };
}
