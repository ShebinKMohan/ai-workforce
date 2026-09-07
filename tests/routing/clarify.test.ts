import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_ANSWERED_EVENT,
  CLARIFICATION_ASKED_EVENT,
  answerClarification,
  assessClarification,
  clarify,
  createEventJournal,
  createMemoryJournal,
  partitionOnClarification,
  type ClarificationCandidate,
  type RepositoryOracle,
} from '../../src/routing/clarify.js';

const emptyOracle: RepositoryOracle = { lookup: () => ({ found: false }) };

const material: ClarificationCandidate = {
  id: 'q1',
  question: 'Should the retry budget be per request or per session?',
  impact: 'changes_deliverable',
  divergentOutcomes: ['a per-request counter in the client', 'a shared counter on the session object'],
  repositoryProbes: ['src/net/client.ts', 'docs/retry.md'],
  affectedTaskIds: ['t-retry'],
};

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 8, 7, 0, 0, clock++)).toISOString();

describe('assessClarification', () => {
  it('warrants a question that changes the deliverable and that the repository cannot answer', async () => {
    const assessment = await assessClarification(material, { oracle: emptyOracle });
    expect(assessment.warranted).toBe(true);
    expect(assessment.verdict).toBe('warranted');
  });

  it('refuses a question the repository already answers', async () => {
    const oracle: RepositoryOracle = {
      lookup: (probe) => (probe === 'docs/retry.md' ? { found: true, answer: 'per session', source: 'docs/retry.md:12' } : { found: false }),
    };
    const assessment = await assessClarification(material, { oracle });
    expect(assessment.warranted).toBe(false);
    expect(assessment.verdict).toBe('answered_by_repository');
    expect(assessment.resolvedFromRepository?.source).toBe('docs/retry.md:12');
  });

  it('refuses a question whose answer does not change the result', async () => {
    const assessment = await assessClarification({ ...material, impact: 'cosmetic' }, { oracle: emptyOracle });
    expect(assessment.verdict).toBe('not_material');
  });

  it('refuses a question with only one possible outcome', async () => {
    const assessment = await assessClarification({ ...material, divergentOutcomes: ['just do it'] }, { oracle: emptyOracle });
    expect(assessment.verdict).toBe('not_material');
    expect(assessment.reason).toContain('does not change the result');
  });

  it('refuses to ask before the repository was looked at', async () => {
    const assessment = await assessClarification({ ...material, repositoryProbes: [] }, { oracle: emptyOracle });
    expect(assessment.verdict).toBe('no_probe_attempted');
  });
});

describe('clarify', () => {
  it('records a warranted question durably', async () => {
    const journal = createMemoryJournal();
    const result = await clarify({ runId: 'run-1', candidate: material, oracle: emptyOracle, journal, now });
    expect(result.assessment.warranted).toBe(true);
    const records = await journal.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.question).toBe(material.question);
    expect(records[0]?.answer).toBeNull();
  });

  it('records a repository-resolved question as asked and answered, so it is not re-litigated', async () => {
    const journal = createMemoryJournal();
    const oracle: RepositoryOracle = { lookup: () => ({ found: true, answer: 'per session', source: 'docs/retry.md:12' }) };
    const result = await clarify({ runId: 'run-1', candidate: material, oracle, journal, now });
    expect(result.record?.resolvedFrom).toBe('repository');
    expect(result.record?.answer).toBe('per session');
    const records = await journal.list();
    expect(records[0]?.answeredAt).not.toBeNull();
  });

  it('records nothing for a question that was never worth asking', async () => {
    const journal = createMemoryJournal();
    const result = await clarify({ runId: 'run-1', candidate: { ...material, impact: 'none' }, oracle: emptyOracle, journal, now });
    expect(result.record).toBeNull();
    expect(await journal.list()).toHaveLength(0);
  });

  it('records the user answer against the question', async () => {
    const journal = createMemoryJournal();
    await clarify({ runId: 'run-1', candidate: material, oracle: emptyOracle, journal, now });
    await answerClarification(journal, 'q1', 'per session', now);
    const records = await journal.list();
    expect(records[0]?.answer).toBe('per session');
    expect(records[0]?.resolvedFrom).toBe('user');
  });

  it('refuses an answer to a question that was never asked', async () => {
    const journal = createMemoryJournal();
    await expect(answerClarification(journal, 'ghost', 'x', now)).rejects.toThrow(/never asked|no clarification/);
  });
});

describe('event journal', () => {
  it('writes an asked and an answered event with stable idempotency keys', async () => {
    const appended: Array<{ type: string; idempotencyKey: string }> = [];
    const journal = createEventJournal({ append: (input) => appended.push({ type: input.type, idempotencyKey: input.idempotencyKey }) });
    await clarify({ runId: 'run-1', candidate: material, oracle: emptyOracle, journal, now });
    await answerClarification(journal, 'q1', 'per session', now);
    expect(appended.map((e) => e.type)).toEqual([CLARIFICATION_ASKED_EVENT, CLARIFICATION_ANSWERED_EVENT]);
    expect(appended[0]?.idempotencyKey).toBe('clarification:asked:q1');
    expect(appended[1]?.idempotencyKey).toBe('clarification:answered:q1');
  });
});

describe('partitionOnClarification', () => {
  it('blocks only the tasks the open question names; everything else continues', async () => {
    const journal = createMemoryJournal();
    await clarify({ runId: 'run-1', candidate: material, oracle: emptyOracle, journal, now });
    const partition = partitionOnClarification(['t-retry', 't-docs', 't-tests'], await journal.list());
    expect(partition.blocked).toEqual(['t-retry']);
    expect(partition.continuing).toEqual(['t-docs', 't-tests']);
    expect(partition.openQuestionIds).toEqual(['q1']);
  });

  it('unblocks the task once the question is answered', async () => {
    const journal = createMemoryJournal();
    await clarify({ runId: 'run-1', candidate: material, oracle: emptyOracle, journal, now });
    await answerClarification(journal, 'q1', 'per session', now);
    const partition = partitionOnClarification(['t-retry', 't-docs'], await journal.list());
    expect(partition.blocked).toEqual([]);
    expect(partition.continuing).toEqual(['t-retry', 't-docs']);
  });
});
