import { materializeInvestigationEvidenceView } from './investigation-replay.ts';
import { engineProjectionDefinitions } from '../../modules/projection/engine-projection-registry.ts';
import type { CurrentChangeOriginReader } from '../../modules/governance-intake/work-registry-contracts.ts';
import type { ChangeContractReaders } from '../../modules/planning-provider/change-contract.ts';
import { invalidContract } from '../../modules/planning-provider/change-contract-errors.ts';
import type {
  ChangeContract,
  ChangeSchemaName,
  CurrentInvestigationManifest,
} from '../../modules/planning-provider/change-contract.ts';
import {
  parseGuardContract,
  validateTaskPolicy,
} from '../../modules/planning-provider/guard-policy.ts';
import { readChangeSchemaName } from './change-metadata.ts';
import {
  assertCommittedCheckoutUnchanged,
  assertCommittedProjectionMatchesCheckout,
  captureExactCleanCommittedCheckout,
} from './committed-checkout.ts';
import {
  canonicalRepositoryRoot,
  compareText,
  digestArtifacts,
  inspectArtifact,
  relative,
} from './contract-artifact-observation.ts';
import {
  loadChecksConfig,
  loadWorkflowConfig,
  readJson,
} from './workflow-configuration.ts';
/**
 * Loads repository workflow contracts and binds planning artifacts to
 * configured policy and evidence.
 *
 * Invariants:
 * - Committed-contract reads require the exact clean commit checkout and
 *   recheck its fingerprint around loading.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertChangeId,
  assertTaskId,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import { validateForAuthority } from '../../modules/investigation/manifest/investigation-manifest.ts';
import { planningProviderBindingPath } from '../../modules/source/planning-paths.ts';
import { readBoundInvestigationManifestPublicationRef } from '../managed-documents/transaction/investigation-publication.ts';
import { investigationManifestPublicationNamespace } from '../../modules/investigation/manifest/investigation-publication-contracts.ts';
import { loadRepositoryConsumerConfiguration } from './repository-consumer.ts';
import { readCommittedInvestigationManifestV3 } from '../repository-transaction/committed-investigation-manifest.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import { assertPolicyPathInsideRepository } from '../session-workspace/paths.ts';
import { workflowContractArtifactPaths } from './workflow-contract-artifacts.ts';

import { type WorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';

import { artifactInvalid } from '../../modules/planning-provider/change-contract-errors.ts';
import {
  isDeltaSpecReferencePath,
  isReferenceTitle,
  parseExecutionArtifact,
  parseTasks,
} from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { type BehaviorContractRef } from '../../modules/planning-provider/planning-artifact-types.ts';
import type { PlanReviewArtifactParser } from '../../modules/assurance/plan-review-artifact.ts';

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
  const validation = validateForAuthority(
    materializeInvestigationEvidenceView,
    {
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
    },
  );
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

/** Construct repository observations with the required full current-origin admission. */
export function createChangeContractReaders(
  readCurrentChangeOrigin: CurrentChangeOriginReader,
  parsePlanReviewArtifact: PlanReviewArtifactParser,
): ChangeContractReaders {
  function loadChangeContract(
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

  function loadCommittedChangeContract(
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
        projectionDirectories = [
          'workflow',
          `${config.changeRoot}/${changeId}`,
        ];
        assertCommittedProjectionMatchesCheckout(
          checkout,
          projectionDirectories,
        );
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
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration.planning
        .currentSchemaName;
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
      readCurrentChangeOrigin(repositoryRoot, changeId);
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
    const behaviorContracts = indexBehaviorContracts(
      changeDirectory,
      specPaths,
    );

    const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
    const guard = parseGuardContract(
      readJson(guardPath, 'guard policy'),
      guardPath,
      changeId,
    );

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
      const normalizedPaths = policy.allowedPaths.map((policyPath) => {
        const normalized = normalizePolicyPath(policyPath);
        assertPolicyPathInsideRepository(repositoryRoot, normalized);
        return normalized;
      });
      validateTaskPolicy(
        taskId,
        policy,
        checks,
        normalizedPaths,
        engineProjectionDefinitions().map(({ path }) => path),
      );
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
  return { loadChangeContract, loadCommittedChangeContract };
}
