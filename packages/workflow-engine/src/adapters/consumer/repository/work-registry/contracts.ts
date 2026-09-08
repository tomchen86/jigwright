import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  validateForAuthority,
  type InvestigationManifestV3,
} from '../../../../modules/investigation/manifest/investigation-manifest.ts';
import {
  investigationManifestPublicationNamespace,
  readBoundInvestigationManifestPublicationRef,
} from '../../../../runtime/managed-documents/transaction/investigation-publication.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGitBuffer,
} from '../../../../runtime/repository-transaction/git.ts';
import {
  readCommittedInvestigationManifestV3,
  type ImmutableGitTreeInvestigationObservation,
} from '../../../../runtime/repository-transaction/committed-investigation-manifest.ts';
import { workflowContractArtifactPaths } from './contract-artifacts.ts';
import {
  isRecord,
  isStringArray,
} from '../../../../foundation/canonical-json/contract-values.ts';
import { engineProjectionDefinitions } from '../../../../modules/projection/engine-projection-registry.ts';
import { validateCurrentChangeOrigin } from '../../../../modules/governance-intake/work-registry.ts';
import {
  assertChangeId,
  assertPolicyPathInsideRepository,
  assertTaskId,
  matchesAllowedPath,
  normalizePolicyPath,
} from '../../../../runtime/session-workspace/paths.ts';
import {
  parseCheckCommand,
  parseChecksConfigSource,
  type CheckDefinition,
  type ChecksConfig,
  type ParsedCheckCommand,
} from '../../../../modules/source/check-command.ts';
import { planningProviderBindingPath } from '../../../../modules/source/planning-paths.ts';
import {
  repositoryConsumerPath,
  repositoryDocumentConfiguration,
  repositoryPlanningConfiguration,
} from '../../../../modules/repository-consumer/repository-consumer-config.ts';

import {
  parseWorkflowConfig,
  workflowNamespaceConfig,
  type WorkflowConfig,
  type TerminalCheckPolicy,
  type TaskAuthorizationPolicy,
} from '../../../../modules/repository-consumer/workflow-config.ts';

import {
  artifactInvalid,
  hasExactKeys,
  isDeltaSpecReferencePath,
  isReferenceTitle,
  parseExecutionArtifact,
  parsePlanReviewArtifact,
  parseTasks,
  type BehaviorContractRef,
  type ExecutionArtifact,
  type GuardContract,
  type ParsedTask,
  type PlanReviewArtifact,
  type TaskPolicy,
} from './contract-parsers.ts';

export {
  isPlanningAssuranceBinding,
  parsePlanReviewArtifact,
  parseExecutionArtifact,
  parseTasks,
} from './contract-parsers.ts';
export type {
  TaskPolicy,
  GuardContract,
  ParsedTask,
  PlanningAssuranceSummary,
  PlanningAssuranceBinding,
  PlanReviewArtifact,
  BehaviorContractRef,
  CrossAgentTddExecution,
  TddSingleAgentExecution,
  TransformationTerm,
  TransformationRetainedDisposition,
  TransformationContract,
  MechanicalTransformExecution,
  DirectReviewedExecution,
  ExecutionTask,
  ExecutionArtifact,
} from './contract-parsers.ts';

export { parseCheckCommand, workflowNamespaceConfig };
export type { WorkflowConfig, TerminalCheckPolicy, TaskAuthorizationPolicy };
export type { CheckDefinition, ChecksConfig, ParsedCheckCommand };

export function repositoryCurrentSchemaName(
  repositoryRoot: string,
): ManagedSchemaName {
  return repositoryPlanningConfiguration(repositoryRoot).currentSchemaName;
}

export function repositoryPlanningPolicy(repositoryRoot: string) {
  return repositoryPlanningConfiguration(repositoryRoot);
}

export function repositoryHandoffPath(repositoryRoot: string): string {
  return repositoryConsumerPath(
    repositoryRoot,
    repositoryHandoffRelativePath(repositoryRoot),
  );
}

export function repositoryHandoffRelativePath(repositoryRoot: string): string {
  return repositoryDocumentConfiguration(repositoryRoot).handoffPath;
}

const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ManagedSchemaName = string;
export type ChangeSchemaName = string;

/**
 * A v3 Manifest replayed from the exact tracked file observed by the active
 * change loader. PlanReview cross-binding is deliberately a later boundary;
 * this value establishes only that the current file is Manifest-authority
 * admissible on its own facts.
 */
export type CurrentInvestigationManifest = {
  manifest: InvestigationManifestV3;
  validation: {
    kind: 'manifest-authority-admissible';
    manifestDigest: string;
    investigationTargetDigest: string;
  };
  currentTreeObservation:
    | {
        kind: 'current-tracked-tree';
        path: string;
        contentDigest: string;
      }
    | ImmutableGitTreeInvestigationObservation;
};

export type ChangeContract = {
  changeId: string;
  changeDirectory: string;
  schemaName: ChangeSchemaName;
  config: WorkflowConfig;
  checks: ChecksConfig;
  guard: GuardContract;
  tasks: ParsedTask[];
  behaviorContracts: BehaviorContractRef[];
  investigation?: CurrentInvestigationManifest;
  execution?: ExecutionArtifact;
  planReview?: PlanReviewArtifact;
  artifactPaths: string[];
  artifactDigests: Record<string, string>;
};

export function loadWorkflowConfig(repositoryRoot: string): WorkflowConfig {
  const configPath = path.join(repositoryRoot, 'workflow/config.json');
  const configuration = parseWorkflowConfig(
    readJson(configPath, 'workflow configuration'),
    configPath,
  );
  if (configuration.taskAuthorization !== undefined) {
    assertPolicyPathInsideRepository(
      repositoryRoot,
      configuration.taskAuthorization.pathRoleRegistry,
    );
  }
  return configuration;
}

export function loadChecksConfig(repositoryRoot: string): ChecksConfig {
  const checksPath = path.join(repositoryRoot, 'workflow/checks.json');
  const value = readJson(checksPath, 'check configuration');
  const parsed = parseChecksConfigSource(value);
  if (!parsed.ok && parsed.reason === 'invalid-registry') {
    throw invalidContract(
      'INVALID_CHECKS_CONFIG',
      'workflow/checks.json does not match schema version 1.',
      checksPath,
    );
  }
  if (!parsed.ok) {
    throw invalidContract(
      'INVALID_CHECK_DEFINITION',
      `Invalid check definition: ${parsed.checkId}`,
      checksPath,
    );
  }
  return parsed.value;
}

export function loadChangeContract(
  repositoryRootInput: string,
  requestedChangeId: string,
  expectedSchemaName?: ChangeSchemaName,
): ChangeContract {
  return loadChangeContractWithInvestigationSource(
    repositoryRootInput,
    requestedChangeId,
    expectedSchemaName,
    { kind: 'live-current-ref' },
  );
}

/**
 * Load a contract from one exact clean checkout whose HEAD is `commit`, while
 * reading the v3 Manifest as an exact 100644 blob from that commit tree. This
 * is not an arbitrary-commit whole-tree loader: every other contract artifact
 * comes from the checkout, so the wrapper pins the checkout before and after
 * the read. It remains separate from the live loader so hooks and task
 * lifecycle paths can never fall back around the private current-ref
 * requirement.
 */
export function loadCommittedChangeContract(
  repositoryRootInput: string,
  commit: string,
  requestedChangeId: string,
  expectedSchemaName?: ChangeSchemaName,
): ChangeContract {
  const checkout = captureExactCleanCommittedCheckout(
    repositoryRootInput,
    commit,
  );
  let projectionDirectories = ['workflow'];
  try {
    assertCommittedProjectionMatchesCheckout(checkout, projectionDirectories);
    const config = loadWorkflowConfig(checkout.repositoryRoot);
    const changeId = assertChangeId(requestedChangeId);
    if (changeId !== 'archive') {
      projectionDirectories = ['workflow', `${config.changeRoot}/${changeId}`];
      assertCommittedProjectionMatchesCheckout(checkout, projectionDirectories);
    }
    const contract = loadChangeContractWithInvestigationSource(
      checkout.repositoryRoot,
      requestedChangeId,
      expectedSchemaName,
      { kind: 'immutable-git-tree', commit },
    );
    assertCommittedProjectionMatchesCheckout(checkout, projectionDirectories);
    assertCommittedCheckoutUnchanged(checkout);
    return contract;
  } catch (error) {
    assertCommittedProjectionMatchesCheckout(checkout, projectionDirectories);
    assertCommittedCheckoutUnchanged(checkout);
    throw error;
  }
}

type ExactCleanCommittedCheckout = Readonly<{
  repositoryRoot: string;
  commit: string;
  fingerprint: string;
}>;

function captureExactCleanCommittedCheckout(
  repositoryRootInput: string,
  commit: string,
): ExactCleanCommittedCheckout {
  try {
    const before = discoverRepository(repositoryRootInput);
    if (before.head !== commit || before.statusEntries.length > 0) {
      throw new Error('checkout does not match');
    }
    const fingerprint = fingerprintWorkingState(
      before.repositoryRoot,
      commit,
      before.statusEntries,
    );
    const after = discoverRepository(before.repositoryRoot);
    if (
      after.head !== commit ||
      after.statusEntries.length > 0 ||
      fingerprintWorkingState(
        after.repositoryRoot,
        commit,
        after.statusEntries,
      ) !== fingerprint
    ) {
      throw new Error('checkout changed during observation');
    }
    return Object.freeze({
      repositoryRoot: before.repositoryRoot,
      commit,
      fingerprint,
    });
  } catch {
    throw committedCheckoutInvalid();
  }
}

function assertCommittedCheckoutUnchanged(
  expected: ExactCleanCommittedCheckout,
): void {
  const observed = captureExactCleanCommittedCheckout(
    expected.repositoryRoot,
    expected.commit,
  );
  if (observed.fingerprint !== expected.fingerprint) {
    throw committedCheckoutInvalid();
  }
}

type CommittedProjectionTreeEntry = Readonly<{
  path: string;
  blob: string;
}>;

/**
 * The committed loader intentionally consumes a checkout projection rather
 * than reconstructing every contract parser over `git cat-file`. Bind that
 * projection before and after parsing: every file in the fixed workflow tree
 * and the selected change tree must be the same ordinary 100644 blob in the
 * exact commit, with no ignored or untracked checkout-only additions.
 */
function assertCommittedProjectionMatchesCheckout(
  checkout: ExactCleanCommittedCheckout,
  directoryPaths: string[],
): void {
  assertCommittedCheckoutDirectoryProjection({
    repositoryRoot: checkout.repositoryRoot,
    commit: checkout.commit,
    directoryPaths,
  });
}

/**
 * Prove that a bounded set of repository directories is exactly the ordinary
 * 100644 file projection stored by one already-pinned commit. Callers retain
 * their own exact-HEAD/status/fingerprint sandwich around this byte proof.
 */
export function assertCommittedCheckoutDirectoryProjection(input: {
  repositoryRoot: string;
  commit: string;
  directoryPaths: readonly string[];
}): void {
  try {
    const repository = canonicalRepositoryRoot(input.repositoryRoot);
    const directories = input.directoryPaths.map((directoryPath) => {
      const normalized = normalizePolicyPath(directoryPath);
      if (
        normalized !== directoryPath ||
        directoryPath.endsWith('/') ||
        repositoryRelativePath(
          repository,
          path.join(repository.lexicalRoot, directoryPath),
        ) !== directoryPath
      ) {
        throw new Error('noncanonical projection directory');
      }
      return directoryPath;
    });
    if (
      directories.length === 0 ||
      new Set(directories).size !== directories.length
    ) {
      throw new Error('invalid projection directory set');
    }

    const treeEntries = readCommittedProjectionTree(
      input.repositoryRoot,
      input.commit,
      directories,
    );
    const checkoutEntries = readCheckoutProjection(repository, directories);
    if (
      treeEntries.size !== checkoutEntries.size ||
      [...treeEntries.keys()].some(
        (entryPath) => !checkoutEntries.has(entryPath),
      )
    ) {
      throw new Error('checkout path set differs from commit projection');
    }
    for (const [entryPath, entry] of treeEntries) {
      const checkoutBytes = checkoutEntries.get(entryPath);
      if (checkoutBytes === undefined) {
        throw new Error('committed projection file is absent from checkout');
      }
      const committedBytes = runGitBuffer(input.repositoryRoot, [
        'cat-file',
        'blob',
        entry.blob,
      ]);
      if (!checkoutBytes.equals(committedBytes)) {
        throw new Error('checkout bytes differ from committed blob');
      }
    }
  } catch {
    throw committedCheckoutInvalid();
  }
}

function readCommittedProjectionTree(
  repositoryRoot: string,
  commit: string,
  directories: string[],
): Map<string, CommittedProjectionTreeEntry> {
  const output = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    '--',
    ...directories.map((directory) => `:(literal)${directory}`),
  ]);
  if (output.length === 0 || output.at(-1) !== 0) {
    throw new Error('committed projection tree is empty or malformed');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const entries = new Map<string, CommittedProjectionTreeEntry>();
  const coveredDirectories = new Set<string>();
  for (const record of text.slice(0, -1).split('\0')) {
    const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)$/u.exec(
      record,
    );
    if (match === null) {
      throw new Error('committed projection contains a non-100644 blob');
    }
    const entryPath = match[2]!;
    const directory = directories.find((candidate) =>
      entryPath.startsWith(`${candidate}/`),
    );
    if (directory === undefined || entries.has(entryPath)) {
      throw new Error('committed projection path is outside its directory');
    }
    coveredDirectories.add(directory);
    entries.set(entryPath, { path: entryPath, blob: match[1]! });
  }
  if (coveredDirectories.size !== directories.length) {
    throw new Error('committed projection directory is absent or empty');
  }
  return entries;
}

function readCheckoutProjection(
  repository: CanonicalRepository,
  directories: string[],
): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const directory of directories) {
    const absoluteDirectory = path.join(repository.lexicalRoot, directory);
    const directoryStats = fs.lstatSync(absoluteDirectory, { bigint: true });
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(absoluteDirectory) !==
        path.join(repository.canonicalRoot, directory)
    ) {
      throw new Error('checkout projection directory is not canonical');
    }
    readCheckoutProjectionDirectory(repository, absoluteDirectory, entries);
  }
  return entries;
}

function readCheckoutProjectionDirectory(
  repository: CanonicalRepository,
  directory: string,
  entries: Map<string, Buffer>,
): void {
  for (const directoryEntry of fs.readdirSync(directory, {
    withFileTypes: true,
  })) {
    const absolutePath = path.join(directory, directoryEntry.name);
    const stats = fs.lstatSync(absolutePath, { bigint: true });
    const entryPath = repositoryRelativePath(repository, absolutePath);
    if (entryPath === undefined || stats.isSymbolicLink()) {
      throw new Error('checkout projection entry is not canonical');
    }
    if (stats.isDirectory()) {
      if (
        fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, entryPath)
      ) {
        throw new Error('checkout projection directory aliases another path');
      }
      readCheckoutProjectionDirectory(repository, absolutePath, entries);
      continue;
    }
    if (!stats.isFile() || logicalGitFileMode(stats.mode) !== '100644') {
      throw new Error('checkout projection entry is not a plain 100644 file');
    }
    if (entries.has(entryPath)) {
      throw new Error('checkout projection contains a duplicate path');
    }
    entries.set(
      entryPath,
      readStableCheckoutProjectionFile(
        repository,
        absolutePath,
        entryPath,
        stats,
      ),
    );
  }
}

function readStableCheckoutProjectionFile(
  repository: CanonicalRepository,
  absolutePath: string,
  entryPath: string,
  before: fs.BigIntStats,
): Buffer {
  let descriptor: number | undefined;
  try {
    if (
      fs.realpathSync(absolutePath) !==
      path.join(repository.canonicalRoot, entryPath)
    ) {
      throw new Error('checkout projection file aliases another path');
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
      throw new Error('checkout projection file changed before reading');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !sameArtifactIdentity(opened, after) ||
      !sameArtifactIdentity(before, pathAfter) ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, entryPath)
    ) {
      throw new Error('checkout projection file changed while reading');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function committedCheckoutInvalid(): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_COMMITTED_CHECKOUT_INVALID',
    'Committed change replay requires one exact clean checkout that remains unchanged.',
    ExitCode.staleState,
  );
}

function loadChangeContractWithInvestigationSource(
  repositoryRootInput: string,
  requestedChangeId: string,
  expectedSchemaName: ChangeSchemaName | undefined,
  investigationSource:
    | { kind: 'live-current-ref' }
    | { kind: 'immutable-git-tree'; commit: string },
): ChangeContract {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const changeId = assertChangeId(requestedChangeId);
  if (changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
      ExitCode.guard,
    );
  }
  const config = loadWorkflowConfig(repositoryRoot);
  const currentSchemaName =
    repositoryPlanningConfiguration(repositoryRoot).currentSchemaName;
  const checks = loadChecksConfig(repositoryRoot);
  for (const policy of config.allTasksTerminalChecks ?? []) {
    for (const checkId of [policy.checkId, ...policy.subsumes]) {
      if (!Object.hasOwn(checks.checks, checkId)) {
        throw invalidContract(
          'UNKNOWN_TERMINAL_CHECK',
          `All-tasks-terminal check policy references an unregistered check: ${checkId}`,
          path.join(repositoryRoot, 'workflow/config.json'),
        );
      }
    }
  }
  const changeDirectory = path.join(
    repositoryRoot,
    config.changeRoot,
    changeId,
  );
  const metadataPath = path.join(changeDirectory, '.openspec.yaml');
  const schemaName = readChangeSchemaName(repositoryRoot, metadataPath);
  if (expectedSchemaName && schemaName !== expectedSchemaName) {
    throw workflowError(
      'OPENSPEC_CHANGE_STATE_CHANGED',
      'Managed change schema selection changed while the contract was loaded.',
      ExitCode.staleState,
    );
  }
  const proposalPath = path.join(changeDirectory, 'proposal.md');
  const designPath = path.join(changeDirectory, 'design.md');
  const tasksPath = path.join(changeDirectory, 'tasks.md');
  const guardPath = path.join(changeDirectory, 'guard.json');
  const investigationPath = path.join(changeDirectory, 'investigation.json');
  const executionPath = path.join(changeDirectory, 'execution.json');
  const originPath = path.join(changeDirectory, 'origin.json');
  const surveyPath = path.join(changeDirectory, 'survey.json');
  const planReviewPath = path.join(changeDirectory, 'plan-review.json');

  if (schemaName === currentSchemaName) {
    validateCurrentChangeOrigin(repositoryRoot, changeId);
  }

  const requiredPaths = [
    proposalPath,
    designPath,
    tasksPath,
    guardPath,
    ...(schemaName === currentSchemaName
      ? [investigationPath, executionPath, planReviewPath]
      : []),
  ];
  for (const requiredPath of requiredPaths) {
    if (!fs.statSync(requiredPath, { throwIfNoEntry: false })?.isFile()) {
      throw invalidContract(
        'MISSING_CHANGE_ARTIFACT',
        `Required change artifact is missing: ${relative(repositoryRoot, requiredPath)}`,
        requiredPath,
      );
    }
  }

  const specPaths = listMarkdownFiles(path.join(changeDirectory, 'specs'));
  if (specPaths.length === 0) {
    throw invalidContract(
      'MISSING_DELTA_SPEC',
      `Change ${changeId} must contain at least one delta spec.`,
      path.join(changeDirectory, 'specs'),
    );
  }
  const behaviorContracts = indexBehaviorContracts(changeDirectory, specPaths);

  const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
  const guard = parseGuardContract(guardPath, changeId);

  if (tasks.length === 0) {
    throw invalidContract(
      'EMPTY_TASK_LIST',
      `Change ${changeId} has no parseable tasks.`,
      tasksPath,
    );
  }

  const markdownTaskIds = new Set(tasks.map((task) => task.id));
  const guardTaskIds = new Set(Object.keys(guard.tasks));

  for (const [taskId, policy] of Object.entries(guard.tasks)) {
    assertTaskId(taskId);
    validateTaskPolicy(repositoryRoot, taskId, policy, checks);
  }

  const missingPolicies = [...markdownTaskIds].filter(
    (taskId) => !guardTaskIds.has(taskId),
  );
  const unknownPolicies = [...guardTaskIds].filter(
    (taskId) => !markdownTaskIds.has(taskId),
  );

  if (missingPolicies.length > 0 || unknownPolicies.length > 0) {
    throw invalidContract(
      'TASK_POLICY_MISMATCH',
      `tasks.md and guard.json task IDs differ for change ${changeId}.`,
      guardPath,
      { missingPolicies, unknownPolicies },
    );
  }

  const investigation =
    schemaName === currentSchemaName
      ? investigationSource.kind === 'live-current-ref'
        ? parseCurrentInvestigationManifest(
            readCanonicalJson(
              investigationPath,
              'investigation artifact',
              'INVALID_INVESTIGATION_ARTIFACT',
            ),
            changeId,
            {
              repositoryRoot,
              expectedRepositoryId: config.repositoryName,
              artifactPath: investigationPath,
            },
          )
        : committedInvestigationManifest(
            repositoryRoot,
            investigationSource.commit,
            config,
            changeId,
          )
      : undefined;
  const execution =
    schemaName === currentSchemaName
      ? parseExecutionArtifact(
          readCanonicalJson(
            executionPath,
            'execution artifact',
            'INVALID_EXECUTION_ARTIFACT',
          ),
          changeId,
          tasks,
          guard,
          checks,
          behaviorContracts,
        )
      : undefined;
  const planReview =
    schemaName === currentSchemaName
      ? parsePlanReviewArtifact(
          readCanonicalJson(
            planReviewPath,
            'plan review artifact',
            'INVALID_PLAN_REVIEW_ARTIFACT',
          ),
          changeId,
        )
      : undefined;
  const artifactPaths = [
    proposalPath,
    designPath,
    tasksPath,
    guardPath,
    ...(schemaName === currentSchemaName
      ? [investigationPath, executionPath, planReviewPath]
      : []),
    ...(schemaName === currentSchemaName &&
    fs.lstatSync(originPath, { throwIfNoEntry: false }) !== undefined
      ? [originPath]
      : []),
    ...(schemaName === currentSchemaName &&
    fs.lstatSync(surveyPath, { throwIfNoEntry: false }) !== undefined
      ? [surveyPath]
      : []),
    ...specPaths,
    ...(fs.lstatSync(
      path.join(repositoryRoot, planningProviderBindingPath(changeId)),
      { throwIfNoEntry: false },
    ) === undefined
      ? []
      : [path.join(repositoryRoot, planningProviderBindingPath(changeId))]),
    ...workflowContractArtifactPaths(repositoryRoot),
  ];

  return {
    changeId,
    changeDirectory,
    schemaName,
    config,
    checks,
    guard,
    tasks,
    behaviorContracts,
    ...(investigation ? { investigation } : {}),
    ...(execution ? { execution } : {}),
    ...(planReview ? { planReview } : {}),
    artifactPaths,
    artifactDigests: digestArtifacts(repositoryRoot, artifactPaths),
  };
}

function committedInvestigationManifest(
  repositoryRoot: string,
  commit: string,
  config: WorkflowConfig,
  changeId: string,
): CurrentInvestigationManifest {
  const committed = readCommittedInvestigationManifestV3({
    repositoryRoot,
    commit,
    changeRoot: config.changeRoot,
    changeId,
    expectedRepositoryId: config.repositoryName,
  });
  return {
    manifest: committed.manifest,
    validation: committed.validation,
    currentTreeObservation: committed.observation,
  };
}

export function readManagedSchemaName(
  repositoryRoot: string,
  metadataPath: string,
): ManagedSchemaName {
  const schemaName = readChangeSchemaName(repositoryRoot, metadataPath);
  const policy = repositoryPlanningConfiguration(repositoryRoot);
  if (!policy.managedSchemaNames.includes(schemaName)) {
    throw workflowError(
      'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
      'Managed changes must declare a reviewed consumer schema.',
      ExitCode.verification,
    );
  }
  return schemaName;
}

export function readChangeSchemaName(
  repositoryRoot: string,
  metadataPath: string,
): ChangeSchemaName {
  const policy = repositoryPlanningConfiguration(repositoryRoot);
  let descriptor: number | undefined;
  let content: Buffer;
  try {
    const repository = canonicalRepositoryRoot(repositoryRoot);
    const absolutePath = path.resolve(metadataPath);
    const artifactRelativePath = repositoryRelativePath(
      repository,
      absolutePath,
    );
    if (!artifactRelativePath) {
      throw new Error('metadata path escapes the repository');
    }
    const before = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, artifactRelativePath) ||
      logicalGitFileMode(before.mode) !== '100644'
    ) {
      throw new Error('unsafe metadata');
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
      throw new Error('metadata identity changed before reading');
    }
    content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !sameArtifactIdentity(opened, after) ||
      !sameArtifactIdentity(before, pathAfter) ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, artifactRelativePath)
    ) {
      throw new Error('metadata identity changed while reading');
    }
  } catch {
    throw unsafeManagedMetadata();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw invalidMetadata();
  }
  if (text.startsWith('\uFEFF') || text.includes('\0') || text.includes('\r')) {
    throw invalidMetadata();
  }
  const singleSchema = /^schema: ([a-z0-9]+(?:-[a-z0-9]+)*)\n$/.exec(text)?.[1];
  if (
    singleSchema !== undefined &&
    policy.packageSchemaNames.includes(singleSchema) &&
    policy.supportedSchemaNames.includes(singleSchema)
  ) {
    return singleSchema;
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-z][a-z0-9-]*): ([^\s].*)$/.exec(line);
    if (!match || fields.has(match[1])) {
      throw invalidMetadata();
    }
    fields.set(match[1], match[2]);
  }
  if (
    fields.size !== 2 ||
    !fields.has('schema') ||
    !fields.has('created') ||
    !isCanonicalDate(fields.get('created') ?? '')
  ) {
    throw invalidMetadata();
  }
  const schemaName = fields.get('schema');
  if (
    schemaName === undefined ||
    !policy.managedSchemaNames.includes(schemaName) ||
    !policy.supportedSchemaNames.includes(schemaName)
  ) {
    throw workflowError(
      'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
      'Managed changes must declare a reviewed consumer schema.',
      ExitCode.verification,
    );
  }
  return schemaName;
}

export function parseCurrentInvestigationManifest(
  value: unknown,
  expectedChangeId: string,
  observation: {
    repositoryRoot: string;
    expectedRepositoryId: string;
    artifactPath: string;
  },
): CurrentInvestigationManifest {
  if (isRecord(value) && value.schemaVersion === 1) {
    throw artifactInvalid(
      'SCHEMA_V1_FORBIDDEN',
      'Schema v1 investigation evidence is historical-only and cannot satisfy the current Manifest boundary.',
    );
  }
  if (isRecord(value) && value.schemaVersion === 2) {
    throw artifactInvalid(
      'PROJECTION_PIPELINE_FORBIDDEN',
      'Schema v2 projected investigation evidence is historical-only and cannot satisfy the current Manifest boundary.',
    );
  }

  const authoring =
    isRecord(value) && isRecord(value.authoring) ? value.authoring : undefined;
  const validation = validateForAuthority({
    repositoryRoot: observation.repositoryRoot,
    manifest: value,
    expected: {
      repositoryId: observation.expectedRepositoryId,
      changeId: expectedChangeId,
      investigationId:
        isRecord(value) && typeof value.investigationId === 'string'
          ? value.investigationId
          : '',
      sessionRevision:
        authoring && typeof authoring.sessionRevision === 'number'
          ? authoring.sessionRevision
          : -1,
      sessionSnapshotDigest:
        authoring && typeof authoring.sessionSnapshotDigest === 'string'
          ? authoring.sessionSnapshotDigest
          : '',
    },
  });
  if (validation.outcome !== 'verified') {
    throw workflowError(
      validation.blocker.failureCode,
      'Current investigation Manifest failed strict authority replay.',
      ExitCode.guard,
      { details: { blocker: validation.blocker } },
    );
  }

  const observed = inspectArtifact(
    canonicalRepositoryRoot(observation.repositoryRoot),
    path.resolve(observation.artifactPath),
  );
  const expectedContentDigest = crypto
    .createHash('sha256')
    .update(`${canonicalJson(validation.manifest)}\n`)
    .digest('hex');
  if (observed.digest !== expectedContentDigest) {
    throw workflowError(
      'REVIEW_TARGET_STALE',
      'The tracked investigation Manifest changed during current-tree observation.',
      ExitCode.staleState,
    );
  }

  const lifecycle = {
    repositoryId: validation.manifest.repositoryId,
    changeId: validation.manifest.changeId,
    investigationId: validation.manifest.investigationId,
    sessionRevision: validation.manifest.authoring.sessionRevision,
    sessionSnapshotDigest: validation.manifest.authoring.sessionSnapshotDigest,
  };
  const runtimeDirectory = loadWorkflowConfig(
    observation.repositoryRoot,
  ).runtimeDirectory;
  const currentRefPath = `${runtimeDirectory}/${investigationManifestPublicationNamespace(
    lifecycle,
  )}/current.json`;
  const repository = discoverRepository(observation.repositoryRoot);
  const currentRef = readBoundInvestigationManifestPublicationRef({
    repositoryRoot: repository.repositoryRoot,
    privateRoot: repository.gitCommonDirectory,
    currentRefPath,
    lifecycle,
    expected: {
      manifestPath: observed.path,
      manifestDigest: validation.manifestDigest,
      investigationTargetDigest: validation.investigationTargetDigest,
    },
  });
  if (currentRef.outcome !== 'read') {
    throw workflowError(
      currentRef.blocker.failureCode,
      'Current investigation Manifest is not the exact private-ref authority.',
      ExitCode.staleState,
      { details: { blocker: currentRef.blocker } },
    );
  }

  return {
    manifest: validation.manifest,
    validation: {
      kind: 'manifest-authority-admissible',
      manifestDigest: validation.manifestDigest,
      investigationTargetDigest: validation.investigationTargetDigest,
    },
    currentTreeObservation: {
      kind: 'current-tracked-tree',
      path: observed.path,
      contentDigest: observed.digest,
    },
  };
}

export function digestArtifacts(
  repositoryRoot: string,
  artifactPaths: string[],
): Record<string, string> {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const entries = artifactPaths
    .map((artifactPath) => inspectArtifact(root, artifactPath))
    .sort((left, right) => compareText(left.path, right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw unsafeContractArtifact();
  }
  return Object.fromEntries(entries.map((entry) => [entry.path, entry.digest]));
}

function inspectArtifact(
  repository: CanonicalRepository,
  artifactPath: string,
): { path: string; digest: string } {
  let descriptor: number | undefined;
  try {
    if (!path.isAbsolute(artifactPath)) {
      throw new Error('artifact path is not absolute');
    }
    const absolutePath = path.resolve(artifactPath);
    const artifactRelativePath = repositoryRelativePath(
      repository,
      absolutePath,
    );
    if (absolutePath !== artifactPath || !artifactRelativePath) {
      throw new Error('artifact path escapes the repository');
    }

    const before = fs.lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      !before?.isFile() ||
      before.isSymbolicLink() ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, artifactRelativePath)
    ) {
      throw new Error('artifact is not a canonical regular file');
    }

    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
      throw new Error('artifact identity changed before reading');
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameArtifactIdentity(opened, after)) {
      throw new Error('artifact identity changed while reading');
    }
    const mode = logicalGitFileMode(after.mode);
    return {
      path: artifactRelativePath,
      digest:
        mode === '100644'
          ? crypto.createHash('sha256').update(content).digest('hex')
          : crypto
              .createHash('sha256')
              .update('workflow-contract-artifact\0mode:100755\0')
              .update(content)
              .digest('hex'),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'UNSAFE_CONTRACT_ARTIFACT'
    ) {
      throw error;
    }
    throw unsafeContractArtifact();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

type CanonicalRepository = {
  lexicalRoot: string;
  canonicalRoot: string;
};

function canonicalRepositoryRoot(repositoryRoot: string): CanonicalRepository {
  try {
    const absoluteRoot = path.resolve(repositoryRoot);
    const stats = fs.lstatSync(absoluteRoot);
    const canonicalRoot = fs.realpathSync(absoluteRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('repository root is not canonical');
    }
    return { lexicalRoot: absoluteRoot, canonicalRoot };
  } catch {
    throw unsafeContractArtifact();
  }
}

function repositoryRelativePath(
  repository: CanonicalRepository,
  artifactPath: string,
): string | undefined {
  for (const root of [repository.lexicalRoot, repository.canonicalRoot]) {
    const candidate = relative(root, artifactPath);
    if (
      candidate !== '' &&
      candidate !== '..' &&
      !candidate.startsWith('../') &&
      !path.isAbsolute(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function logicalGitFileMode(mode: bigint): '100644' | '100755' {
  return (mode & 0o111n) === 0n ? '100644' : '100755';
}

function sameArtifactIdentity(left: fs.BigIntStats, right: fs.BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsafeContractArtifact() {
  return workflowError(
    'UNSAFE_CONTRACT_ARTIFACT',
    'Workflow contract artifacts must be canonical repository regular files.',
    ExitCode.guard,
  );
}

function parseGuardContract(
  guardPath: string,
  expectedChangeId: string,
): GuardContract {
  const value = readJson(guardPath, 'guard policy');

  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['changeId', 'schemaVersion', 'tasks']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length === 0
  ) {
    throw invalidContract(
      'INVALID_GUARD_CONTRACT',
      `guard.json is invalid or does not name change ${expectedChangeId}.`,
      guardPath,
    );
  }

  for (const [taskId, policy] of Object.entries(value.tasks)) {
    if (
      !isRecord(policy) ||
      !hasOneOfExactKeySets(policy, [
        ['allowedPaths', 'requiredChecks'],
        ['allowedPaths', 'exclusiveResources', 'requiredChecks'],
      ]) ||
      !isStringArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !isStringArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0 ||
      (policy.exclusiveResources !== undefined &&
        !isExclusiveResourceSet(policy.exclusiveResources))
    ) {
      throw invalidContract(
        'INVALID_TASK_POLICY',
        `Invalid guard policy for task ${taskId}.`,
        guardPath,
      );
    }
  }

  return value as GuardContract;
}

function isExclusiveResourceSet(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    value.every(
      (resource) =>
        resource.length <= 160 && /^[a-z0-9][a-z0-9._:/-]*$/.test(resource),
    ) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function validateTaskPolicy(
  repositoryRoot: string,
  taskId: string,
  policy: TaskPolicy,
  checks: ChecksConfig,
): void {
  const normalizedPaths = policy.allowedPaths.map((policyPath) => {
    const normalized = normalizePolicyPath(policyPath);
    assertPolicyPathInsideRepository(repositoryRoot, normalized);
    return normalized;
  });

  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw workflowError(
      'DUPLICATE_ALLOWED_PATH',
      `Task ${taskId} contains duplicate allowed paths.`,
      ExitCode.guard,
    );
  }

  const claimedProjectionPaths = engineProjectionDefinitions()
    .map(({ path: projectionPath }) => projectionPath)
    .filter((projectionPath) =>
      normalizedPaths.some((allowedPath) =>
        matchesAllowedPath(projectionPath, allowedPath),
      ),
    );
  if (claimedProjectionPaths.length > 0) {
    throw workflowError(
      'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE',
      `Task ${taskId} cannot claim engine-owned projection paths.`,
      ExitCode.guard,
      { details: { taskId, claimedProjectionPaths } },
    );
  }

  const malformedChecks = policy.requiredChecks.filter(
    (checkId) => !CHECK_ID_PATTERN.test(checkId),
  );
  if (malformedChecks.length > 0) {
    throw workflowError(
      'INVALID_REQUIRED_CHECK_ID',
      `Task ${taskId} contains malformed required check IDs: ${malformedChecks.join(', ')}`,
      ExitCode.guard,
      { details: { taskId, malformedChecks } },
    );
  }

  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
    throw workflowError(
      'DUPLICATE_REQUIRED_CHECK',
      `Task ${taskId} contains duplicate required checks.`,
      ExitCode.guard,
    );
  }

  const unknownChecks = policy.requiredChecks.filter(
    (checkId) => !Object.hasOwn(checks.checks, checkId),
  );
  if (unknownChecks.length > 0) {
    throw workflowError(
      'UNKNOWN_REQUIRED_CHECK',
      `Task ${taskId} references unknown checks: ${unknownChecks.join(', ')}`,
      ExitCode.guard,
      { details: { taskId, unknownChecks } },
    );
  }
}

function hasOneOfExactKeySets(
  value: Record<string, unknown>,
  expectedKeySets: readonly (readonly string[])[],
): boolean {
  return expectedKeySets.some((keys) => hasExactKeys(value, [...keys]));
}

function listMarkdownFiles(directory: string): string[] {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function indexBehaviorContracts(
  changeDirectory: string,
  specPaths: string[],
): BehaviorContractRef[] {
  const refs: BehaviorContractRef[] = [];
  for (const specPath of specPaths) {
    const relativeSpecPath = relative(changeDirectory, specPath);
    if (!isDeltaSpecReferencePath(relativeSpecPath)) {
      continue;
    }
    const requirements = new Map<
      string,
      { count: number; scenarios: Map<string, number> }
    >();
    let currentRequirement:
      { count: number; scenarios: Map<string, number> } | undefined;
    for (const line of fs.readFileSync(specPath, 'utf8').split('\n')) {
      const requirementMatch = /^### Requirement: (.+)$/.exec(line);
      if (requirementMatch) {
        const title = requirementMatch[1];
        if (!isReferenceTitle(title)) {
          currentRequirement = undefined;
          continue;
        }
        currentRequirement = requirements.get(title) ?? {
          count: 0,
          scenarios: new Map<string, number>(),
        };
        currentRequirement.count += 1;
        requirements.set(title, currentRequirement);
        continue;
      }
      if (/^#{1,3}(?:\s|$)/.test(line)) {
        currentRequirement = undefined;
        continue;
      }
      const scenarioMatch = /^#### Scenario: (.+)$/.exec(line);
      if (
        !scenarioMatch ||
        !currentRequirement ||
        !isReferenceTitle(scenarioMatch[1])
      ) {
        continue;
      }
      const title = scenarioMatch[1];
      currentRequirement.scenarios.set(
        title,
        (currentRequirement.scenarios.get(title) ?? 0) + 1,
      );
    }
    for (const [requirement, entry] of requirements) {
      if (entry.count !== 1) {
        continue;
      }
      refs.push({ specPath: relativeSpecPath, requirement, scenario: null });
      for (const [scenario, count] of entry.scenarios) {
        if (count === 1) {
          refs.push({ specPath: relativeSpecPath, requirement, scenario });
        }
      }
    }
  }
  return refs.sort((left, right) =>
    compareText(canonicalJson(left), canonicalJson(right)),
  );
}

function readCanonicalJson(
  filePath: string,
  label: string,
  errorCode:
    | 'INVALID_INVESTIGATION_ARTIFACT'
    | 'INVALID_EXECUTION_ARTIFACT'
    | 'INVALID_PLAN_REVIEW_ARTIFACT',
): unknown {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      fs.readFileSync(filePath),
    );
    value = JSON.parse(text);
    if (text !== `${canonicalJson(value)}\n`) {
      throw new Error('noncanonical JSON');
    }
  } catch {
    throw invalidContract(
      errorCode,
      `Unable to read canonical ${label}.`,
      filePath,
    );
  }
  return value;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function invalidMetadata() {
  return workflowError(
    'OPENSPEC_CHANGE_METADATA_INVALID',
    'Managed change metadata must contain one reviewed schema and canonical created date.',
    ExitCode.guard,
  );
}

function unsafeManagedMetadata() {
  return workflowError(
    'OPENSPEC_CHANGE_TREE_UNSAFE',
    'Managed change metadata must be a canonical non-executable repository file.',
    ExitCode.unsafeEnvironment,
  );
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'UNREADABLE_CONTRACT',
      `Unable to read ${label}: ${relative(process.cwd(), filePath)}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          filePath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function invalidContract(
  code: string,
  message: string,
  filePath: string,
  details: Record<string, unknown> = {},
): ReturnType<typeof workflowError> {
  return workflowError(code, message, ExitCode.guard, {
    details: { filePath, ...details },
  });
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
