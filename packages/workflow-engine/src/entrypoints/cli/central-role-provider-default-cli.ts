/**
 * Routes role/provider configuration commands and presents the terminal
 * setup questions.
 *
 * Invariants:
 * - Production configuration prompts require interactive standard input and
 *   standard error.
 */
import { createInterface } from 'node:readline/promises';

import {
  configureCentralRoleProviderDefaultProduction,
  inspectCentralRoleProviderDefault,
  simulateCentralRoleProviderDefaultProduction,
  type CentralRoleProviderDefaultInspection as ProductionCentralRoleProviderDefaultInspection,
  type CentralRoleProviderDefaultPromptSession,
  type CentralRoleProviderDefaultWizardPromptPort,
  type CentralRoleProviderDefaultWizardResult,
  type CentralRoleProviderDefaultSimulationReport,
} from '../../composition-root/central-role-provider-default-production.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type CentralRoleProviderDefaultCliOptions = Readonly<{
  platform?: NodeJS.Platform;
  prompt?: CentralRoleProviderDefaultWizardPromptPort;
}>;

export type CentralRoleProviderDefaultPromptQuestionPort = Readonly<{
  ask(question: string): Promise<string>;
}>;

export type CentralRoleProviderDefaultInspection =
  ProductionCentralRoleProviderDefaultInspection;

export type CentralRoleProviderDefaultCliResult =
  | CentralRoleProviderDefaultInspection
  | CentralRoleProviderDefaultWizardResult
  | CentralRoleProviderDefaultSimulationReport;

export async function dispatchCentralRoleProviderDefaultCommand(
  args: readonly string[],
  repositoryRoot: string,
  options: CentralRoleProviderDefaultCliOptions = {},
): Promise<CentralRoleProviderDefaultCliResult> {
  if (args.length === 1 && args[0] === 'show') {
    return inspectCentralRoleProviderDefault(repositoryRoot);
  }
  if (
    args.length === 5 &&
    args[0] === 'simulate' &&
    args[1] === '--config' &&
    typeof args[2] === 'string' &&
    args[3] === '--caller' &&
    typeof args[4] === 'string'
  ) {
    return simulateCentralRoleProviderDefaultProduction(
      repositoryRoot,
      args[2],
      args[4],
      options.platform ?? process.platform,
    );
  }
  if (
    args.length !== 3 ||
    args[0] !== 'configure' ||
    args[1] !== '--config' ||
    typeof args[2] !== 'string'
  ) {
    throw usage();
  }

  return configureCentralRoleProviderDefaultProduction(
    repositoryRoot,
    args[2],
    options.platform ?? process.platform,
    () =>
      options.prompt === undefined
        ? createProductionPromptSession()
        : Object.freeze({ prompt: options.prompt, close() {} }),
  );
}

export function createCentralRoleProviderDefaultTerminalPrompt(
  questions: CentralRoleProviderDefaultPromptQuestionPort,
): CentralRoleProviderDefaultWizardPromptPort {
  return Object.freeze({
    async chooseProviderPartition(choices) {
      return chooseNumber(
        questions,
        ['Choose provider groups', ...choices.map(renderChoice)].join('\n'),
        choices.map(({ option }) => option),
      );
    },
    async chooseSessionPartition({ roles, choices }) {
      return chooseNumber(
        questions,
        [
          `Choose sessions within ${roles.join(', ')}`,
          ...choices.map((choice) =>
            renderChoice({ ...choice, notation: choice.notation }),
          ),
        ].join('\n'),
        choices.map(({ option }) => option),
      );
    },
    async chooseProviderRule({ roles, choices }) {
      const option = await chooseNumber(
        questions,
        [
          `Choose provider rule for ${roles.join(', ')}`,
          ...choices.map((choice, index) => `${index + 1}. ${choice.label}`),
        ].join('\n'),
        choices.map((_choice, index) => index + 1),
      );
      return choices[option - 1]!.rule;
    },
    async reorderProviderRanking(ranking) {
      const mutable = [...ranking];
      while (true) {
        const answer = (
          await questions.ask(
            [
              'Provider ranking',
              ...mutable.map(
                (logicalProviderId, index) =>
                  `${index + 1}. ${logicalProviderId}`,
              ),
              'Enter "up <n>", "down <n>", or "done".',
            ].join('\n'),
          )
        )
          .trim()
          .toLowerCase();
        if (answer === 'done') return Object.freeze(mutable);
        const move = /^(up|down) ([1-9][0-9]*)$/u.exec(answer);
        if (move === null) throw promptInvalid();
        const from = Number(move[2]) - 1;
        const to = move[1] === 'up' ? from - 1 : from + 1;
        if (
          from < 0 ||
          from >= mutable.length ||
          to < 0 ||
          to >= mutable.length
        ) {
          throw promptInvalid();
        }
        [mutable[from], mutable[to]] = [mutable[to]!, mutable[from]!];
      }
    },
    async confirm(summary) {
      const answer = (
        await questions.ask(
          `${summary}\nSave these declarative rules? [yes/no]`,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'yes' || answer === 'y') return true;
      if (answer === 'no' || answer === 'n') return false;
      throw promptInvalid();
    },
  });
}

function createProductionPromptSession(): CentralRoleProviderDefaultPromptSession {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    throw workflowError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_TTY_REQUIRED',
      'Central role/provider setup requires an interactive terminal.',
      ExitCode.unsafeEnvironment,
    );
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  return Object.freeze({
    prompt: createCentralRoleProviderDefaultTerminalPrompt({
      ask(question) {
        return terminal.question(`${question}\n> `);
      },
    }),
    close() {
      terminal.close();
    },
  });
}

async function chooseNumber<T extends number>(
  questions: CentralRoleProviderDefaultPromptQuestionPort,
  question: string,
  allowed: readonly T[],
): Promise<T> {
  const answer = (await questions.ask(question)).trim();
  if (!/^[1-9][0-9]*$/u.test(answer)) throw promptInvalid();
  const selected = Number(answer) as T;
  if (!allowed.includes(selected)) throw promptInvalid();
  return selected;
}

function renderChoice(
  choice: Readonly<{ option: number; notation: string }>,
): string {
  return `${choice.option}. ${choice.notation}`;
}

function usage() {
  return workflowError(
    'INVALID_ROLE_CONFIG_USAGE',
    'Usage: pnpm workflow role-config <show|configure --config <absolute-host-path>|simulate --config <absolute-host-path> --caller <logical-provider-id>> [--json]',
    ExitCode.usage,
  );
}

function promptInvalid() {
  return workflowError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_PROMPT_INVALID',
    'Central role/provider setup received an invalid terminal response.',
    ExitCode.usage,
  );
}
