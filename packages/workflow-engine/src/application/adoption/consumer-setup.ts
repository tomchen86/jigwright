import {
  defaultWorkflowSetup,
  defaultConsumerSetup,
  defaultJigwrightProfile,
} from '../../modules/adoption/setup-questions.ts';
/** Resolves setup answers, preflights the complete configuration and then applies writes. */
import path from 'node:path';
import {
  SETUP_QUESTIONS,
  PROFILE_PATH,
  CONSUMER_PATH,
  CONFIG_PATH,
  GUIDANCE_PATH,
  atKey,
  setKey,
  mergeMissing,
  assertSetupAnswer,
  initError,
  renderProviderConfiguration,
  type Answers,
  type Question,
  type SetupDefaults,
  type SetupProviderDefinition,
} from '../../modules/adoption/setup-questions.ts';
import { parseRepositoryConsumerConfiguration } from '../../modules/repository-consumer/repository-consumer-policy.ts';
import { parseWorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';

export type ConsumerSetupRepository = Readonly<{
  root: string;
  read(relativePath: string): Answers;
  exists(relativePath: string): boolean;
  assertPath(relativePath: string): void;
  write(relativePath: string, value: Answers): void;
  profileDigest(): string;
}>;
export type ConsumerSetupHost = Readonly<{
  readState(): { path: string; value: Answers };
  defaultProviderPath(): string | null;
  exists(absolutePath: string): boolean;
  validateProviderPath(absolutePath: string): string;
  canonicalPath(absolutePath: string): string;
  providerDefaults(): {
    providers: readonly SetupProviderDefinition[];
    existingExecutables: readonly string[];
  };
  validateProviderDocument(document: string): void;
  createProviderConfig(absolutePath: string, document: string): void;
  writeState(absolutePath: string, value: Answers): void;
}>;
export function createConsumerSetupService(
  repository: ConsumerSetupRepository,
  hostStorage: ConsumerSetupHost,
  guidance: Readonly<{
    suggestions(): string[];
    install(
      targets: readonly string[],
      options: { onDiff?: (diff: string) => void },
    ): unknown;
  }>,
) {
  const root = repository.root;
  function defaultFacts(question: Question): SetupDefaults {
    if (question.id === 'providerConfig')
      return { providerConfig: hostStorage.defaultProviderPath() };
    if (question.id === 'providers') return hostStorage.providerDefaults();
    if (question.id === 'guidanceTargets')
      return { guidanceTargets: guidance.suggestions() };
    if (question.id === 'consumerId')
      return {
        repositoryName: repository.read(CONFIG_PATH).repositoryName,
        repositoryBasename: path.basename(root),
      };
    return {};
  }
  function validateAnswer(question: Question, answer: unknown): void {
    assertSetupAnswer(question, answer);
    if (question.id === 'providerConfig' && typeof answer === 'string')
      hostStorage.validateProviderPath(answer);
  }
  function writeMissingConfig(
    relativePath: string,
    defaults: Answers,
  ): boolean {
    const current = repository.read(relativePath);
    const merged = mergeMissing(current, defaults);
    if (JSON.stringify(current) === JSON.stringify(merged)) return false;
    repository.write(relativePath, merged);
    return true;
  }
  async function initialize(
    options: Readonly<{
      answers: Answers;
      help?: boolean;
      openPrompt?: () => {
        ask?: (prompt: string) => Promise<string>;
        close: () => void;
      };
      onDiff?: (diff: string) => void;
    }>,
  ) {
    const answers = options.answers;
    const help = options.help;
    if (help)
      return {
        questions: SETUP_QUESTIONS.map(({ id, flag, prompt, destination }) => ({
          id,
          flag,
          prompt,
          destination,
        })),
        usage:
          'jigwright init [--answers <json-file>] [--non-interactive] [question flags] [--json]',
      };
    for (const question of SETUP_QUESTIONS) {
      if (Object.hasOwn(answers, question.id))
        validateAnswer(question, answers[question.id]);
    }
    const { path: hostPath, value: host } = hostStorage.readState();
    const consumer = repository.read(CONSUMER_PATH);
    const currentConfig = repository.read(CONFIG_PATH);
    const profileExisted = repository.exists(PROFILE_PATH);
    repository.read(PROFILE_PATH);
    const prompt = options.openPrompt?.();
    const ask = prompt?.ask;
    const applied: string[] = [];
    const pending: string[] = [];
    const resolved: Answers = {};
    let hostChanged = false;
    let guidanceTargets: string[] | undefined;
    try {
      for (const question of SETUP_QUESTIONS) {
        if (question.when && !question.when(resolved)) continue;
        if (
          question.id === 'providers' &&
          hostStorage.exists(resolved.providerConfig as string)
        )
          continue;
        const target =
          question.destination === 'host'
            ? host
            : question.destination === 'provider-toml'
              ? {}
              : repository.read(question.destination);
        let existing = atKey(target, question.key);
        if (
          question.id === 'guidanceTargets' &&
          existing === undefined &&
          host.guidanceDeclined === true
        )
          existing = [];
        if (existing !== undefined) {
          resolved[question.id] = existing;
          continue;
        }
        let answer = answers[question.id];
        if (!Object.hasOwn(answers, question.id)) {
          if (ask) {
            const fallback = question.defaultValue(defaultFacts(question));
            const entered = await ask(
              `${question.prompt} [${typeof fallback === 'string' ? fallback : JSON.stringify(fallback)}]: `,
            );
            try {
              answer = entered.trim()
                ? question.parse(entered.trim())
                : fallback;
            } catch {
              throw initError(
                'JIGWRIGHT_INIT_ANSWER_INVALID',
                `Invalid answer for ${question.id}.`,
              );
            }
            if (
              question.id === 'guidanceTargets' &&
              Array.isArray(answer) &&
              answer.length > 0
            ) {
              const confirmation = await ask(
                `Install Jigwright guidance in ${JSON.stringify(answer)}? [y/N]: `,
              );
              if (!/^y(?:es)?$/iu.test(confirmation.trim())) answer = [];
            }
          } else if (question.explicit) {
            pending.push(question.id);
            continue;
          } else answer = question.defaultValue(defaultFacts(question));
        }
        validateAnswer(question, answer);
        if (question.id === 'providerConfig' && typeof answer === 'string')
          answer = hostStorage.canonicalPath(answer);
        resolved[question.id] = answer;
        if (question.id === 'providerConfig') {
          host.providerConfig = answer;
          hostChanged = true;
        } else if (question.id === 'guidanceTargets') {
          if ((answer as string[]).length > 0)
            guidanceTargets = answer as string[];
          else {
            host.guidanceDeclined = true;
            hostChanged = true;
          }
        } else if (question.id !== 'providers')
          setKey(consumer, question.key, answer);
        applied.push(question.id);
      }
    } finally {
      prompt?.close();
    }

    const providerPath =
      typeof resolved.providerConfig === 'string'
        ? resolved.providerConfig
        : undefined;
    const creatingProviderConfig =
      providerPath !== undefined && !hostStorage.exists(providerPath);
    if (Object.hasOwn(answers, 'providers') && !creatingProviderConfig)
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'providers requires a new host provider config path; init never overwrites existing provider configuration.',
      );
    if (
      creatingProviderConfig &&
      (!Array.isArray(resolved.providers) || providerPath === hostPath)
    )
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'A new host provider config requires providers and a separate TOML destination.',
      );
    const providerDocument = creatingProviderConfig
      ? renderProviderConfiguration(
          resolved.providers as Answers[],
          hostStorage.providerDefaults().providers,
        )
      : undefined;
    if (providerDocument !== undefined)
      hostStorage.validateProviderDocument(providerDocument);
    const consumerId = resolved.consumerId as string;
    if (
      currentConfig.repositoryName !== undefined &&
      currentConfig.repositoryName !== consumerId
    ) {
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'consumerId must match the existing workflow/config.json repositoryName.',
      );
    }
    const configuration = defaultWorkflowSetup(consumerId);
    const parsedWorkflow = parseWorkflowConfig(
      mergeMissing(currentConfig, configuration),
      path.join(root, CONFIG_PATH),
    );
    for (const configuredPath of [
      parsedWorkflow.changeRoot,
      parsedWorkflow.runtimeDirectory,
      ...(parsedWorkflow.taskAuthorization
        ? [parsedWorkflow.taskAuthorization.pathRoleRegistry]
        : []),
    ])
      repository.assertPath(configuredPath);
    const consumerConfiguration = mergeMissing(
      consumer,
      defaultConsumerSetup(consumerId),
    );
    const parsedConsumer = parseRepositoryConsumerConfiguration(
      consumerConfiguration,
    );
    for (const configuredPath of [
      parsedConsumer.documents.handoffPath,
      ...Object.entries(parsedConsumer.workRegistry)
        .filter(([key]) => key !== 'adapterId')
        .map(([, value]) => value),
    ])
      repository.assertPath(configuredPath);
    // Validate every answer and existing config before installing user guidance.
    if (guidanceTargets)
      guidance.install(guidanceTargets, { onDiff: options.onDiff });
    if (providerDocument !== undefined)
      hostStorage.createProviderConfig(providerPath!, providerDocument);
    const configurationChanged = writeMissingConfig(CONFIG_PATH, configuration);
    const consumerChanged = writeMissingConfig(
      CONSUMER_PATH,
      consumerConfiguration,
    );
    if (hostChanged) hostStorage.writeState(hostPath, host);
    const profileChanged = writeMissingConfig(
      PROFILE_PATH,
      defaultJigwrightProfile(),
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: 'jigwright-init-result.v1',
      status: !profileExisted
        ? 'initialized'
        : applied.length > 0 ||
            configurationChanged ||
            consumerChanged ||
            profileChanged
          ? 'updated'
          : 'unchanged',
      path: PROFILE_PATH,
      digest: repository.profileDigest(),
      applied,
      pending,
      guidanceSuggestions: pending.includes('guidanceTargets')
        ? guidance.suggestions()
        : [],
    });
  }

  return Object.freeze({ initialize });
}
