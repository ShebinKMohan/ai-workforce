/**
 * Interactive questions, on `node:readline` and nothing else.
 *
 * This package takes no runtime dependency but zod, so there is no prompt
 * library here: a question is a line written to the output stream and a line
 * read back from the input stream. That constraint turns out to be the right
 * shape anyway, because the rules a launcher needs are rules a library would
 * have to be argued out of:
 *
 * - **Every byte goes to the output stream it was given**, which the launcher
 *   points at stderr. `--json` is a contract about stdout, and the easiest way
 *   to never break it is for the questions to have no way of reaching stdout.
 * - **End of input is an interruption, not an empty answer.** A closed stdin
 *   (Ctrl+D, or a pipe that ran dry) means nobody is there to answer, so the
 *   pending question rejects with exit 130 rather than resolving to `''` and
 *   letting a default carry a run nobody asked for.
 * - **A malformed answer is re-asked, but not forever.** `MAX_ANSWER_ATTEMPTS`
 *   bounds it, so a stream feeding junk fails with exit 2 instead of spinning.
 * - **Colour is decoration only.** `colorEnabled` already honours `NO_COLOR`
 *   and `TERM=dumb`; without it every question reads exactly the same.
 *
 * The `Prompter` interface is what the launcher depends on, so a test drives
 * the whole session with a scripted answer list and no terminal at all.
 */
import { createInterface, type Interface } from 'node:readline';
import { bold, colorEnabled, dim, paint } from './ansi.js';
import { CliError, EXIT_CODES } from './output.js';

/** How many unusable answers one question takes before it gives up (exit 2). */
export const MAX_ANSWER_ATTEMPTS = 5;

/** One option in a `choose`. `unavailable` is the reason it cannot be taken, and it is shown. */
export interface Choice {
  readonly value: string;
  readonly label: string;
  /** Second column: what the reader needs to pick correctly. */
  readonly detail?: string;
  /** When set, the choice is listed, is refused if selected, and this says why and what to do about it. */
  readonly unavailable?: string;
}

export interface AskOptions {
  /** Returned when the answer is empty, and shown in the prompt. */
  readonly defaultValue?: string;
  /** Accept an empty answer as an empty string instead of re-asking. */
  readonly allowEmpty?: boolean;
  /** One dim line under the question: what the answer is for. */
  readonly hint?: string;
}

export interface ChooseOptions {
  readonly defaultValue?: string;
  readonly hint?: string;
}

export interface Prompter {
  /** A plain line. */
  say(line?: string): void;
  /** A secondary line: dim where colour is available. */
  note(line: string): void;
  /** A section title. */
  heading(line: string): void;
  ask(question: string, options?: AskOptions): Promise<string>;
  /** Resolves to the `value` of the chosen, available `Choice`. */
  choose(question: string, choices: ReadonlyArray<Choice>, options?: ChooseOptions): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /**
   * Run `action` with this prompter's hold on the terminal released.
   *
   * An external editor takes over the same terminal, and a readline interface
   * left in raw mode would swallow the keystrokes meant for it. Nothing else
   * needs this, so it stays a one-purpose door rather than a general
   * suspend/resume protocol.
   */
  suspend<T>(action: () => Promise<T> | T): Promise<T>;
  close(): void;
}

/** Nobody is there to answer: exit 130, the same code an interrupted run uses. */
export function inputClosed(): CliError {
  return new CliError(EXIT_CODES.interrupted, 'input_closed', 'input ended before the question was answered; nothing was started');
}

function tooManyAttempts(question: string): CliError {
  return new CliError(EXIT_CODES.invalidInput, 'no_usable_answer', `no usable answer to "${question}" after ${MAX_ANSWER_ATTEMPTS} attempts`, [
    'the interactive launcher needs a person at the terminal; the same run can be started with flags — see "workforce --help"',
  ]);
}

export interface PrompterIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * A prompter over a real (or fake) pair of streams.
 *
 * `terminal` follows the output's own `isTTY`, so a test with two plain
 * streams gets no escape codes, no echo and no line editing, and the same
 * code path otherwise.
 */
export function createReadlinePrompter(io: PrompterIo): Prompter {
  const env = io.env ?? process.env;
  const color = colorEnabled(io.output, env);
  const terminal = (io.output as { isTTY?: unknown }).isTTY === true;
  const rl: Interface = createInterface({ input: io.input, output: io.output, terminal });
  // A Ctrl+C at a question is an answer about the session, not about the
  // question: close the interface, which rejects whatever was pending with
  // the interruption error below.
  rl.on('SIGINT', () => rl.close());
  let closed = false;
  rl.on('close', () => (closed = true));

  const write = (text: string): void => {
    io.output.write(`${text}\n`);
  };

  const readLine = (query: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (closed) {
        reject(inputClosed());
        return;
      }
      let answered = false;
      const onClose = (): void => {
        if (answered) return;
        answered = true;
        reject(inputClosed());
      };
      rl.once('close', onClose);
      rl.question(query, (answer) => {
        if (answered) return;
        answered = true;
        rl.removeListener('close', onClose);
        resolve(answer);
      });
    });

  const prompter: Prompter = {
    say(line = '') {
      write(line);
    },
    note(line) {
      write(dim(line, color));
    },
    heading(line) {
      write('');
      write(bold(line, color));
    },
    async ask(question, options = {}) {
      const suffix = options.defaultValue !== undefined && options.defaultValue.length > 0 ? dim(` [${options.defaultValue}]`, color) : '';
      if (options.hint !== undefined) write(dim(`  ${options.hint}`, color));
      for (let attempt = 0; attempt < MAX_ANSWER_ATTEMPTS; attempt += 1) {
        const answer = (await readLine(`${question}${suffix}: `)).trim();
        if (answer.length > 0) return answer;
        if (options.defaultValue !== undefined) return options.defaultValue;
        if (options.allowEmpty === true) return '';
        write(dim('  an answer is required', color));
      }
      throw tooManyAttempts(question);
    },
    async choose(question, choices, options = {}) {
      if (choices.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'no_choices', `there is nothing to choose for "${question}"`);
      const available = choices.filter((choice) => choice.unavailable === undefined);
      if (options.hint !== undefined) write(dim(`  ${options.hint}`, color));
      const width = Math.max(...choices.map((choice) => choice.label.length));
      choices.forEach((choice, index) => {
        const number = `${index + 1})`;
        const label = choice.label.padEnd(width);
        const detail = choice.unavailable !== undefined ? paint(`unavailable — ${choice.unavailable}`, 'yellow', color) : choice.detail === undefined ? '' : dim(choice.detail, color);
        write(`  ${choice.unavailable !== undefined ? dim(number, color) : number} ${label}  ${detail}`.trimEnd());
      });
      // Only an available choice may be the default, so pressing Enter can
      // never select something the run would then refuse.
      const fallback = options.defaultValue !== undefined && available.some((choice) => choice.value === options.defaultValue) ? options.defaultValue : undefined;
      for (let attempt = 0; attempt < MAX_ANSWER_ATTEMPTS; attempt += 1) {
        const raw = (await readLine(`${question}${fallback === undefined ? '' : dim(` [${fallback}]`, color)}: `)).trim();
        if (raw.length === 0 && fallback !== undefined) return fallback;
        const byNumber = /^[0-9]+$/.test(raw) ? choices[Number(raw) - 1] : undefined;
        const picked = byNumber ?? choices.find((choice) => choice.value === raw || choice.label === raw);
        if (picked === undefined) {
          write(dim(`  answer with a number from 1 to ${choices.length}, or the name`, color));
          continue;
        }
        if (picked.unavailable !== undefined) {
          write(paint(`  ${picked.label} cannot be used: ${picked.unavailable}`, 'yellow', color));
          continue;
        }
        return picked.value;
      }
      throw tooManyAttempts(question);
    },
    async confirm(question, fallback) {
      for (let attempt = 0; attempt < MAX_ANSWER_ATTEMPTS; attempt += 1) {
        const raw = (await readLine(`${question} ${dim(fallback ? '[Y/n]' : '[y/N]', color)}: `)).trim().toLowerCase();
        if (raw.length === 0) return fallback;
        if (raw === 'y' || raw === 'yes') return true;
        if (raw === 'n' || raw === 'no') return false;
        write(dim('  answer y or n', color));
      }
      throw tooManyAttempts(question);
    },
    async suspend(action) {
      const input = io.input as NodeJS.ReadStream;
      const wasRaw = input.isRaw === true;
      if (wasRaw && typeof input.setRawMode === 'function') input.setRawMode(false);
      rl.pause();
      try {
        return await action();
      } finally {
        if (!closed) {
          rl.resume();
          if (wasRaw && typeof input.setRawMode === 'function') input.setRawMode(true);
        }
      }
    },
    close() {
      if (!closed) rl.close();
    },
  };
  return prompter;
}
