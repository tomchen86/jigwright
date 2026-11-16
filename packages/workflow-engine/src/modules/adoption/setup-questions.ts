/** Setup question, answer, defaults and provider-document policy without host or repository IO. */
import path from 'node:path';
import {
  isBuiltInProviderFamily,
  listBuiltInProviderFamilies,
} from '@jigwright/core/built-in-provider-catalog';
export type SetupProviderDefinition = Readonly<{
  providerFamily: string;
  trustTier: string;
  enabled: boolean;
  protocol: string;
  executableCandidates: readonly string[];
}>;
export type SetupDefaults = Readonly<{
  providerConfig?: string | null;
  providers?: readonly SetupProviderDefinition[];
  existingExecutables?: readonly string[];
  guidanceTargets?: readonly string[];
  repositoryName?: unknown;
  repositoryBasename?: string;
}>;
export const PROFILE_PATH = 'workflow/jigwright-profile.json';
export const CONSUMER_PATH = 'workflow/repository-consumer.json';
export const CONFIG_PATH = 'workflow/config.json';
export const GUIDANCE_PATH = 'workflow/agent-guidance.json';
export type Answers = Record<string, unknown>;
export type Question = Readonly<{
  id: string;
  flag: string;
  prompt: string;
  destination: string;
  key: readonly string[];
  defaultValue: (facts: SetupDefaults) => unknown;
  parse: (value: string) => unknown;
  valid: (value: unknown) => boolean;
  explicit?: boolean;
  when?: (answers: Answers) => boolean;
}>;
const relativeMarkdown = (value: unknown): value is string =>
  typeof value === 'string' &&
  !path.isAbsolute(value) &&
  !value.includes('\\') &&
  !/[\r\n\0]/u.test(value) &&
  value
    .split('/')
    .every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..',
    ) &&
  /\.(md|markdown)$/iu.test(value);

/** Question order, defaults, flags, validation and storage destinations live here. */
export const SETUP_QUESTIONS: readonly Question[] = Object.freeze([
  {
    id: 'providerConfig',
    flag: '--provider-config',
    prompt:
      'Host provider TOML path, existing or new (empty skips provider setup)',
    destination: 'host',
    key: ['providerConfig'],
    explicit: true,
    defaultValue: (facts) => facts.providerConfig ?? null,
    parse: (value) => value || null,
    valid: (value) =>
      value === null ||
      (typeof value === 'string' &&
        path.isAbsolute(value) &&
        !/[\r\n\0]/u.test(value)),
  },
  {
    id: 'providers',
    flag: '--providers',
    prompt: 'Providers to add (JSON array of {id, family, executable})',
    destination: 'provider-toml',
    key: ['providers'],
    explicit: true,
    when: (answers) => typeof answers.providerConfig === 'string',
    defaultValue: (facts) => {
      const family = listBuiltInProviderFamilies()[0]!;
      const definition = facts.providers?.find(
        (definition) => definition.providerFamily === family,
      );
      return definition
        ? [
            {
              id: `${family}-local`,
              family,
              executable:
                definition.executableCandidates.find((candidate) =>
                  facts.existingExecutables?.includes(candidate),
                ) ?? definition.executableCandidates[0],
            },
          ]
        : [];
    },
    parse: (value) => JSON.parse(value),
    valid: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (provider) =>
          isObject(provider) &&
          Object.keys(provider).sort().join(',') === 'executable,family,id' &&
          typeof provider.id === 'string' &&
          isBuiltInProviderFamily(provider.family) &&
          typeof provider.executable === 'string' &&
          path.isAbsolute(provider.executable),
      ),
  },
  {
    id: 'guidanceTargets',
    flag: '--guidance-target',
    prompt: 'Instruction Markdown paths to install (JSON array; [] skips)',
    destination: GUIDANCE_PATH,
    key: ['targets'],
    explicit: true,
    defaultValue: (facts) => facts.guidanceTargets ?? [],
    parse: (value) => JSON.parse(value),
    valid: (value) =>
      Array.isArray(value) && value.every((target) => relativeMarkdown(target)),
  },
  {
    id: 'consumerId',
    flag: '--consumer-id',
    prompt: 'Repository identifier',
    destination: CONSUMER_PATH,
    key: ['consumerId'],
    defaultValue: (facts) =>
      facts.repositoryName ??
      (path
        .basename(facts.repositoryBasename ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, '-')
        .replace(/^[^a-z]+/u, '')
        .slice(0, 64) ||
        'repository'),
    parse: (value) => value,
    valid: (value) =>
      typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value),
  },
  {
    id: 'handoffPath',
    flag: '--handoff-path',
    prompt: 'Handoff document path',
    destination: CONSUMER_PATH,
    key: ['documents', 'handoffPath'],
    defaultValue: () => 'docs/CURRENT_AND_NEXT_STEPS.md',
    parse: (value) => value,
    valid: relativeMarkdown,
  },
  {
    id: 'databasePolicy',
    flag: '--database-policy',
    prompt: 'Database policy (disabled-v1 or postgresql-disposable-v1)',
    destination: CONSUMER_PATH,
    key: ['databasePolicy', 'adapterId'],
    defaultValue: () => 'disabled-v1',
    parse: (value) => value,
    valid: (value) =>
      value === 'disabled-v1' || value === 'postgresql-disposable-v1',
  },
]);

export function renderProviderConfiguration(
  providers: Answers[],
  definitions: readonly SetupProviderDefinition[],
): string {
  const ranking = JSON.stringify(providers.map(({ id }) => id));
  const blocks = providers.map((provider) => {
    if (!isBuiltInProviderFamily(provider.family))
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'Unknown built-in provider family.',
      );
    const definition = definitions.find(
      (definition) => definition.providerFamily === provider.family,
    );
    if (!definition)
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'This built-in provider has no definition for the current platform.',
      );
    return [
      '[[providers]]',
      `id = ${JSON.stringify(provider.id)}`,
      `family = ${JSON.stringify(definition.providerFamily)}`,
      `trust_tier = ${JSON.stringify(definition.trustTier)}`,
      `enabled = ${definition.enabled}`,
      `protocol = ${JSON.stringify(definition.protocol)}`,
      `executable = ${JSON.stringify(provider.executable)}`,
    ].join('\n');
  });
  const document =
    [
      `schema_version = 2\nglobal_ranking = ${ranking}`,
      ...blocks,
      `[provider_preferences]\nauthor = ${ranking}\nbuilder = ${ranking}\nreviewer = ${ranking}`,
    ].join('\n\n') + '\n';
  return document;
}

export function isObject(value: unknown): value is Answers {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function atKey(value: Answers, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (isObject(current) ? current[key] : undefined),
    value,
  );
}
export function setKey(
  value: Answers,
  keys: readonly string[],
  answer: unknown,
): void {
  const [head, ...tail] = keys;
  if (tail.length === 0) {
    value[head!] = answer;
    return;
  }
  if (!isObject(value[head!])) value[head!] = {};
  setKey(value[head!] as Answers, tail, answer);
}
export function mergeMissing(existing: Answers, defaults: Answers): Answers {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(merged, key)) merged[key] = value;
    else if (isObject(merged[key]) && isObject(value))
      merged[key] = mergeMissing(merged[key], value);
  }
  return merged;
}
export function initError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function assertSetupAnswer(question: Question, answer: unknown): void {
  if (!question.valid(answer))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      `Invalid answer for ${question.id}.`,
    );
}

export function defaultWorkflowSetup(consumerId: string): Answers {
  return {
    schemaVersion: 1,
    repositoryName: consumerId,
    consumerNamespace: consumerId,
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    allowedPathModes: ['exact', 'directory-prefix'],
  };
}
export function defaultConsumerSetup(consumerId: string): Answers {
  return {
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId,
    planning: {
      providerId: 'openspec',
      packageSchemaNames: ['spec-driven'],
      requiredSchemaNames: ['spec-driven', 'jigwright'],
      supportedSchemaNames: ['spec-driven', 'jigwright'],
      managedSchemaNames: ['jigwright'],
      currentSchemaName: 'jigwright',
    },
    documents: { adapterId: 'filesystem-documents-v1' },
    databasePolicy: { adapterId: 'disabled-v1' },
  };
}
export function defaultJigwrightProfile(): Answers {
  return {
    schemaVersion: 1,
    kind: 'jigwright-consumer-profile.v1',
    ordinary: {
      requiredIndependence: 'session-independent',
      providerMode: 'single-provider-allowed',
      roleSessions: ['author', 'builder', 'reviewer'],
      sessionFreshness: 'fresh-per-role',
      perChangeAgentPlan: 'optional-override',
      signedGrants: 0,
      forcedDiversityCalls: 0,
      quietTriggeredDuplicateAttempts: 0,
      repeatedAuthorizedDataEgressPrompts: 0,
    },
    capabilities: {
      agentRuntime: 'optional',
      grants: 'optional-fail-closed-when-required',
      githubAdapter: 'optional',
      workRegistry: 'consumer-owned',
    },
  };
}
