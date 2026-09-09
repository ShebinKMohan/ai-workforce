/**
 * The prompting layer: what it does with an answer, a wrong answer, and no
 * answer at all.
 *
 * The driver below answers a question only once the question has actually been
 * written, which is what a person does and what keeps these tests free of
 * sleeps. When the script runs out it closes the input instead — the end of
 * input is one of the behaviours under test.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createReadlinePrompter, MAX_ANSWER_ATTEMPTS, type Choice } from '../../src/cli/prompt.js';
import { EXIT_CODES } from '../../src/cli/output.js';

/** The escape character, spelled out so no literal control byte lives in this file. */
const ESC = String.fromCharCode(27);

interface Driver {
  readonly prompter: ReturnType<typeof createReadlinePrompter>;
  readonly written: () => string;
  readonly consumed: () => number;
}

function driver(answers: ReadonlyArray<string>, env: Record<string, string | undefined> = { NO_COLOR: '1' }): Driver {
  const input = new PassThrough();
  let text = '';
  let index = 0;
  const output = {
    write(chunk: string | Uint8Array) {
      const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      text += value;
      // A prompt is a line that stops without a newline, waiting for someone.
      if (value.endsWith(': ')) {
        if (index < answers.length) {
          const answer = answers[index]!;
          index += 1;
          setImmediate(() => input.write(`${answer}\n`));
        } else {
          setImmediate(() => input.end());
        }
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { prompter: createReadlinePrompter({ input, output, env }), written: () => text, consumed: () => index };
}

const CHOICES: ReadonlyArray<Choice> = [
  { value: 'engineer', label: 'engineer', detail: 'fake via script' },
  { value: 'reviewer', label: 'reviewer', unavailable: 'codex is signed out — run: codex login' },
];

describe('asking for text', () => {
  it('returns the answer, and the default when the answer is empty', async () => {
    const first = driver(['  Fix the off-by-one.  ']);
    expect(await first.prompter.ask('what should the agent do?')).toBe('Fix the off-by-one.');
    first.prompter.close();

    const second = driver(['']);
    expect(await second.prompter.ask('repository', { defaultValue: '/tmp/repo' })).toBe('/tmp/repo');
    second.prompter.close();
  });

  it('re-asks when an answer is required and empty, rather than accepting silence', async () => {
    const session = driver(['', 'npm test']);
    expect(await session.prompter.ask('which command decides acceptance?')).toBe('npm test');
    expect(session.written()).toContain('an answer is required');
    session.prompter.close();
  });

  it('gives up with exit 2 after too many unusable answers instead of spinning', async () => {
    const session = driver(new Array(MAX_ANSWER_ATTEMPTS + 1).fill(''));
    await expect(session.prompter.ask('which command decides acceptance?')).rejects.toMatchObject({
      exitCode: EXIT_CODES.invalidInput,
      code: 'no_usable_answer',
    });
    expect(session.consumed()).toBe(MAX_ANSWER_ATTEMPTS);
    session.prompter.close();
  });
});

describe('choosing from a list', () => {
  it('accepts a number or a name, and lists what cannot be picked with the reason', async () => {
    const byNumber = driver(['1']);
    expect(await byNumber.prompter.choose('which agent?', CHOICES)).toBe('engineer');
    expect(byNumber.written()).toContain('codex is signed out — run: codex login');
    byNumber.prompter.close();

    const byName = driver(['engineer']);
    expect(await byName.prompter.choose('which agent?', CHOICES)).toBe('engineer');
    byName.prompter.close();
  });

  it('refuses an unavailable choice, says why, and asks again', async () => {
    const session = driver(['2', 'engineer']);
    expect(await session.prompter.choose('which agent?', CHOICES)).toBe('engineer');
    expect(session.written()).toContain('reviewer cannot be used: codex is signed out');
    session.prompter.close();
  });

  it('re-asks on an answer that is neither, and takes the default only when it is available', async () => {
    const garbage = driver(['what?', '1']);
    expect(await garbage.prompter.choose('which agent?', CHOICES)).toBe('engineer');
    expect(garbage.written()).toContain('answer with a number from 1 to 2');
    garbage.prompter.close();

    const defaulted = driver(['']);
    expect(await defaulted.prompter.choose('which agent?', CHOICES, { defaultValue: 'engineer' })).toBe('engineer');
    defaulted.prompter.close();

    // A default nobody may pick is not a default: the question is asked properly.
    const unavailableDefault = driver(['engineer']);
    expect(await unavailableDefault.prompter.choose('which agent?', CHOICES, { defaultValue: 'reviewer' })).toBe('engineer');
    expect(unavailableDefault.written()).not.toContain('[reviewer]');
    unavailableDefault.prompter.close();
  });
});

describe('confirming', () => {
  it('takes y/n in either length and falls back on an empty answer', async () => {
    const yes = driver(['yes']);
    expect(await yes.prompter.confirm('start this run?', false)).toBe(true);
    yes.prompter.close();

    const no = driver(['n']);
    expect(await no.prompter.confirm('start this run?', true)).toBe(false);
    no.prompter.close();

    const fallback = driver(['']);
    expect(await fallback.prompter.confirm('start this run?', true)).toBe(true);
    fallback.prompter.close();

    const nonsense = driver(['maybe', 'n']);
    expect(await nonsense.prompter.confirm('start this run?', true)).toBe(false);
    expect(nonsense.written()).toContain('answer y or n');
    nonsense.prompter.close();
  });
});

describe('when nobody is there', () => {
  it('treats the end of input as an interruption, not as an empty answer', async () => {
    const session = driver([]);
    await expect(session.prompter.ask('what should the agent do?')).rejects.toMatchObject({
      exitCode: EXIT_CODES.interrupted,
      code: 'input_closed',
    });
  });

  it('rejects a question asked after the input already closed', async () => {
    const session = driver([]);
    await expect(session.prompter.confirm('start this run?', true)).rejects.toMatchObject({ code: 'input_closed' });
    await expect(session.prompter.ask('anything?')).rejects.toMatchObject({ code: 'input_closed' });
  });
});

describe('output discipline', () => {
  it('writes every byte to the stream it was given and emits no escapes under NO_COLOR', async () => {
    const session = driver(['engineer']);
    session.prompter.heading('agents');
    session.prompter.note('passive discovery only');
    await session.prompter.choose('which agent?', CHOICES);
    session.prompter.close();
    expect(session.written()).not.toContain(ESC);
    expect(session.written()).toContain('agents');
    expect(session.written()).toContain('passive discovery only');
  });

  it('colours the same session when the terminal allows it, and changes nothing it says', async () => {
    const session = driver(['engineer'], { FORCE_COLOR: '1' });
    session.prompter.heading('agents');
    await session.prompter.choose('which agent?', CHOICES);
    session.prompter.close();
    expect(session.written()).toContain(ESC);
    expect(session.written()).toContain('which agent?');
  });

  it('runs a suspended action and hands back its result', async () => {
    const session = driver([]);
    expect(await session.prompter.suspend(() => 'edited text')).toBe('edited text');
    session.prompter.close();
  });
});
