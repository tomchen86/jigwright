/** Owns setup command argument handling and terminal prompt lifetime. */
import { createInterface } from 'node:readline/promises';
import {
  createConsumerSetup,
  readSetupAnswers,
  SETUP_QUESTIONS,
  initError,
  type Answers,
} from '../../composition-root/consumer-setup-production.ts';
export { configuredJigwrightEnvironment } from '../../composition-root/consumer-setup-production.ts';
export async function initializeJigwrightConsumer(
  repositoryRoot: string,
  options: Readonly<{
    argv?: readonly string[];
    ask?: (prompt: string) => Promise<string>;
    onDiff?: (diff: string) => void;
  }> = {},
) {
  const setup = createConsumerSetup(repositoryRoot);
  const { answers, interactive, help } = parseSetupArguments(
    options.argv ?? [],
  );
  return setup.initialize({
    answers,
    help,
    onDiff: options.onDiff,
    openPrompt() {
      const terminal =
        interactive && !options.ask
          ? createInterface({ input: process.stdin, output: process.stderr })
          : undefined;
      const ask =
        options.ask ??
        (terminal ? (prompt: string) => terminal.question(prompt) : undefined);
      return { ask, close: () => terminal?.close() };
    },
  });
}
function parseSetupArguments(argv: readonly string[]) {
  const answers: Answers = {};
  let interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--json' || flag === '--non-interactive') {
      interactive = false;
      continue;
    }
    if (flag === '--help') {
      help = true;
      continue;
    }
    if (flag === '--no-provider') {
      answers.providerConfig = null;
      continue;
    }
    if (flag === '--no-guidance') {
      answers.guidanceTargets = [];
      continue;
    }
    const question = SETUP_QUESTIONS.find((entry) => entry.flag === flag);
    if (flag !== '--answers' && !question)
      throw initError(
        'JIGWRIGHT_INIT_ARGUMENT_INVALID',
        `Unknown init argument: ${flag}.`,
      );
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw initError(
        'JIGWRIGHT_INIT_ARGUMENT_INVALID',
        `${flag} requires a value.`,
      );
    if (flag === '--answers') {
      const supplied = readSetupAnswers(value);
      for (const id of Object.keys(supplied))
        if (!SETUP_QUESTIONS.some((entry) => entry.id === id))
          throw initError(
            'JIGWRIGHT_INIT_ANSWER_INVALID',
            `Unknown setup answer: ${id}.`,
          );
      Object.assign(answers, supplied);
    } else if (question!.id === 'guidanceTargets') {
      answers.guidanceTargets = [
        ...((answers.guidanceTargets as string[] | undefined) ?? []),
        value,
      ];
    } else answers[question!.id] = question!.parse(value);
  }
  return { answers, interactive, help };
}
