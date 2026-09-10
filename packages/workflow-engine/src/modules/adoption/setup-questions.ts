/**
 * Collects setup answers and initializes consumer and host provider
 * configuration.
 *
 * Invariants:
 * - Initialization never overwrites an existing host provider
 *   configuration.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  isBuiltInProviderFamily,
  listBuiltInProviderFamilies,
  parseAgentProviderConfigToml,
  resolveBuiltInProviderDefinitionSnapshot,
} from '@jigwright/agent-runtime';

import { guidanceSuggestions, installAgentGuidance } from './agent-guidance.ts';
import { parseRepositoryConsumerConfiguration } from '../repository-consumer/repository-consumer-config.ts';
import { parseWorkflowConfig } from '../repository-consumer/workflow-config.ts';

const PROFILE_PATH = 'workflow/jigwright-profile.json';
const CONSUMER_PATH = 'workflow/repository-consumer.json';
const CONFIG_PATH = 'workflow/config.json';
const GUIDANCE_PATH = 'workflow/agent-guidance.json';
type Answers = Record<string, unknown>;
type Question = Readonly<{
  id: string;
  flag: string;
  prompt: string;
  destination: string;
  key: readonly string[];
  defaultValue: (root: string) => unknown;
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
    defaultValue: () => process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG ?? null,
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
    when: (answers) =>
      typeof answers.providerConfig === 'string' &&
      !fs.existsSync(answers.providerConfig),
    defaultValue: () => {
      const family = listBuiltInProviderFamilies()[0]!;
      const definition = resolveBuiltInProviderDefinitionSnapshot(
        family,
        process.platform,
      );
      return definition
        ? [
            {
              id: `${family}-local`,
              family,
              executable:
                definition.executableCandidates.find((candidate) =>
                  fs.existsSync(candidate),
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
    defaultValue: (root) => guidanceSuggestions(root),
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
    defaultValue: (root) =>
      readConfig(root, CONFIG_PATH).repositoryName ??
      (path
        .basename(root)
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

export async function initializeJigwrightConsumer(
  repositoryRoot: string,
  options: Readonly<{
    argv?: readonly string[];
    ask?: (prompt: string) => Promise<string>;
    onDiff?: (diff: string) => void;
  }> = {},
) {
  const root = fs.realpathSync(repositoryRoot);
  const { answers, interactive, help } = parseSetupArguments(
    options.argv ?? [],
  );
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
      validateAnswer(root, question, answers[question.id]);
  }
  const hostPath = setupHostPath(root);
  const host = readObject(hostPath);
  const consumer = readConfig(root, CONSUMER_PATH);
  const currentConfig = readConfig(root, CONFIG_PATH);
  const profileExisted = fs.existsSync(path.join(root, PROFILE_PATH));
  readConfig(root, PROFILE_PATH);
  const terminal =
    interactive && !options.ask
      ? createInterface({ input: process.stdin, output: process.stderr })
      : undefined;
  const ask =
    options.ask ??
    (terminal ? (prompt: string) => terminal.question(prompt) : undefined);
  const applied: string[] = [];
  const pending: string[] = [];
  const resolved: Answers = {};
  let hostChanged = false;
  let guidanceTargets: string[] | undefined;
  try {
    for (const question of SETUP_QUESTIONS) {
      if (question.when && !question.when(resolved)) continue;
      const target =
        question.destination === 'host'
          ? host
          : question.destination === 'provider-toml'
            ? {}
            : readConfig(root, question.destination);
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
          const fallback = question.defaultValue(root);
          const entered = await ask(
            `${question.prompt} [${typeof fallback === 'string' ? fallback : JSON.stringify(fallback)}]: `,
          );
          try {
            answer = entered.trim() ? question.parse(entered.trim()) : fallback;
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
        } else answer = question.defaultValue(root);
      }
      validateAnswer(root, question, answer);
      if (question.id === 'providerConfig' && typeof answer === 'string')
        answer = canonicalProspectivePath(answer);
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
    terminal?.close();
  }

  const providerPath =
    typeof resolved.providerConfig === 'string'
      ? resolved.providerConfig
      : undefined;
  const creatingProviderConfig =
    providerPath !== undefined && !fs.existsSync(providerPath);
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
    ? renderProviderConfiguration(resolved.providers as Answers[])
    : undefined;
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
  const configuration = {
    schemaVersion: 1,
    repositoryName: consumerId,
    consumerNamespace: consumerId,
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main', 'master'],
    branchTemplate: 'work/{changeId}',
    allowedPathModes: ['exact', 'directory-prefix'],
  };
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
    assertSafePath(root, path.join(root, configuredPath));
  const consumerConfiguration = mergeMissing(consumer, {
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
  });
  const parsedConsumer = parseRepositoryConsumerConfiguration(
    consumerConfiguration,
  );
  for (const configuredPath of [
    parsedConsumer.documents.handoffPath,
    ...Object.entries(parsedConsumer.workRegistry)
      .filter(([key]) => key !== 'adapterId')
      .map(([, value]) => value),
  ])
    assertSafePath(root, path.join(root, configuredPath));
  // Validate every answer and existing config before installing user guidance.
  if (guidanceTargets)
    installAgentGuidance(root, guidanceTargets, { onDiff: options.onDiff });
  if (providerDocument !== undefined) {
    fs.mkdirSync(path.dirname(providerPath!), { recursive: true, mode: 0o700 });
    fs.writeFileSync(providerPath!, providerDocument, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const configurationChanged = writeMissingConfig(
    root,
    CONFIG_PATH,
    configuration,
  );
  const consumerChanged = writeMissingConfig(
    root,
    CONSUMER_PATH,
    consumerConfiguration,
  );
  if (hostChanged) writeJson(hostPath, host, 0o600);
  const profileChanged = writeMissingConfig(root, PROFILE_PATH, {
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
  });
  const bytes = fs.readFileSync(path.join(root, PROFILE_PATH));
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
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    applied,
    pending,
    guidanceSuggestions: pending.includes('guidanceTargets')
      ? guidanceSuggestions(root)
      : [],
  });
}

/** Provider configuration remains host-owned; repository files never receive its path or contents. */
export function configuredJigwrightEnvironment(
  repositoryRoot: string,
): NodeJS.ProcessEnv {
  if (process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG !== undefined)
    return process.env;
  const configured = readObject(
    setupHostPath(fs.realpathSync(repositoryRoot)),
  ).providerConfig;
  return typeof configured === 'string'
    ? { ...process.env, JIGWRIGHT_AGENT_PROVIDER_CONFIG: configured }
    : process.env;
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
      if (!fs.existsSync(path.resolve(value)))
        throw initError(
          'JIGWRIGHT_INIT_ANSWER_INVALID',
          'Setup answers file does not exist.',
        );
      const supplied = readObject(path.resolve(value));
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

function validateAnswer(
  root: string,
  question: Question,
  answer: unknown,
): void {
  if (!question.valid(answer))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      `Invalid answer for ${question.id}.`,
    );
  if (question.id === 'providerConfig' && typeof answer === 'string') {
    const providerPath = canonicalProspectivePath(answer);
    if (providerPath === root || providerPath.startsWith(`${root}${path.sep}`))
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'Provider configuration must remain outside the repository.',
      );
    if (fs.existsSync(providerPath))
      parseAgentProviderConfigToml(fs.readFileSync(providerPath, 'utf8'), {
        platform: process.platform,
      });
  }
}

function renderProviderConfiguration(providers: Answers[]): string {
  const ranking = JSON.stringify(providers.map(({ id }) => id));
  const blocks = providers.map((provider) => {
    if (!isBuiltInProviderFamily(provider.family))
      throw initError(
        'JIGWRIGHT_INIT_ANSWER_INVALID',
        'Unknown built-in provider family.',
      );
    const definition = resolveBuiltInProviderDefinitionSnapshot(
      provider.family,
      process.platform,
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
  parseAgentProviderConfigToml(document, { platform: process.platform });
  return document;
}

function canonicalProspectivePath(requestedPath: string): string {
  const resolvedPath = path.resolve(requestedPath);
  let existingParent = resolvedPath;
  while (true) {
    const stats = fs.lstatSync(existingParent, { throwIfNoEntry: false });
    if (stats) {
      if (stats.isSymbolicLink() && !fs.existsSync(existingParent))
        throw initError(
          'JIGWRIGHT_INIT_PATH_UNSAFE',
          'Host configuration path contains a dangling symbolic link.',
        );
      break;
    }
    existingParent = path.dirname(existingParent);
  }
  if (
    existingParent !== resolvedPath &&
    !fs.statSync(existingParent).isDirectory()
  )
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Host configuration parent must be a directory.',
    );
  return path.resolve(
    fs.realpathSync(existingParent),
    path.relative(existingParent, resolvedPath),
  );
}

function setupHostPath(root: string): string {
  const requestedDirectory = path.resolve(
    process.env.JIGWRIGHT_SETUP_HOME ??
      path.join(os.homedir(), '.config', 'jigwright', 'setup'),
  );
  const directory = canonicalProspectivePath(requestedDirectory);
  if (directory === root || directory.startsWith(`${root}${path.sep}`))
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Setup host state must remain outside the repository.',
    );
  return path.join(
    directory,
    `${crypto.createHash('sha256').update(root).digest('hex')}.json`,
  );
}

function readConfig(root: string, relativePath: string): Answers {
  const target = path.join(root, relativePath);
  assertSafePath(root, target);
  return readObject(target);
}
function readObject(target: string): Answers {
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) return {};
  if (!stats.isFile() || stats.isSymbolicLink())
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Setup configuration must be a regular file.',
    );
  const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!isObject(value))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      'Setup configuration must be a JSON object.',
    );
  return value;
}
function isObject(value: unknown): value is Answers {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function atKey(value: Answers, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (isObject(current) ? current[key] : undefined),
    value,
  );
}
function setKey(
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
function mergeMissing(existing: Answers, defaults: Answers): Answers {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(merged, key)) merged[key] = value;
    else if (isObject(merged[key]) && isObject(value))
      merged[key] = mergeMissing(merged[key], value);
  }
  return merged;
}
function writeMissingConfig(
  root: string,
  relativePath: string,
  defaults: Answers,
): boolean {
  const current = readConfig(root, relativePath);
  const merged = mergeMissing(current, defaults);
  if (JSON.stringify(current) === JSON.stringify(merged)) return false;
  const target = path.join(root, relativePath);
  assertSafePath(root, target);
  writeJson(target, merged, 0o644);
  return true;
}
function writeJson(target: string, value: Answers, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode,
    });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function assertSafePath(root: string, target: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stats?.isSymbolicLink() ||
      (stats && current !== target && !stats.isDirectory())
    )
      throw initError(
        'JIGWRIGHT_INIT_PATH_UNSAFE',
        'Setup configuration path is unsafe.',
      );
  }
}
function initError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
