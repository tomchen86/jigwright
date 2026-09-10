/**
 * Builds and verifies an archive transformation in a temporary detached
 * worktree.
 *
 * Invariants:
 * - A transformation is returned only after rebuilt specs validate and the
 *   original eligibility remains current.
 */
import {
  boundedArchiveCauseDiagnostic,
  withinDiagnosticBudget,
} from './archive-diagnostics.ts';
export { boundedArchiveCauseDiagnostic } from './archive-diagnostics.ts';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBaseSpecificationPath } from '../../modules/source/system-spec-catalog.ts';
import type { SystemDescriptionSnapshot } from '../../modules/source/spec-ownership.ts';
import { readSystemSpecDeltaInputs } from '../../modules/source/system-spec-deltas.ts';

import type { ArchiveEligibility } from './archive-eligibility.ts';
import {
  assertSpecDeltaPreconditions,
  verifyProjectedSpecDeltaOutcome,
  type SpecDeltaPreflightRecord,
} from '../../runtime/repository-transaction/archive-delta-verifier.ts';
import {
  assertPlainArchiveOutputFile,
  listPlainArchiveFiles,
} from '../../runtime/repository-transaction/archive-output-safety.ts';
import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  inspectPlanningArchiveReadiness,
  preparePlanningArchiveProjection,
  validatePlanningArchiveProjectedSpecs,
  type PlanningArchiveProjection,
  type PlanningArchiveProjectionContext,
  type PlanningArchiveProjectionPort,
} from '../../modules/planning-provider/planning-archive-projection-port.ts';
import {
  createOpenSpecPlanningArchiveProjectionPort,
  createArchiveProjectionDependencies,
} from '../../composition-root/planning-archive-projection-production.ts';
import { createTrustedExecutionEnvironment } from '../../runtime/provider-execution/execution-environment.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  readFileAtCommit,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { renderHandoffFromTrackedFacts } from '../../adapters/consumer/repository/handoff/handoff.ts';
import { repositoryHandoffRelativePath } from '../../adapters/consumer/repository/work-registry/contracts.ts';
import {
  assertPlanningPaths,
  requiredPlanningArtifactPaths,
} from '../../modules/source/planning-paths.ts';
import { reconcileArchivedWorkItems } from '../../modules/governance-intake/work-registry.ts';
import { completionDocumentPaths } from '../../runtime/managed-documents/validation/managed-documents.ts';
import {
  assertChangeId,
  normalizeChangedPath,
} from '../../runtime/session-workspace/paths.ts';
import type { ResolvedPlanningProviderBinding } from '../../modules/planning-provider/planning-provider-binding.ts';

export type ArchiveTransformation = {
  changeId: string;
  archiveName: string;
  archivePath: string;
  baseSpecPaths: string[];
  changedPaths: string[];
  patch: string;
  patchDigest: string;
  tree: string;
  archivedArtifactDigests: Record<string, string>;
  providerVersion: string;
  totals?: ArchiveTotals;
};

export type ArchiveApplicabilityProjectionInput = {
  repositoryRoot: string;
  changeRoot: string;
  changeId: string;
  baselineCommit: string;
  sourceCommit: string;
  activeArtifactPaths: string[];
  planningProvider: ResolvedPlanningProviderBinding;
  source: 'worktree' | 'commit';
  now?: Date;
};

export type ArchiveTransformationTestHooks = {
  aroundArchivePreparation?<T>(invoke: () => T): T;
  aroundProjectedSpecValidation?<T>(invoke: () => T): T;
};

type ArchiveTotals = {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
};

type ArchivePayload = {
  archivedAs: string;
  specsUpdated: boolean;
  totals?: ArchiveTotals;
};

type PublicArchivePayload = ArchivePayload & { archivePath: string };

export function createArchiveTransformation(
  eligibility: ArchiveEligibility,
  options: {
    now?: () => Date;
    testHooks?: ArchiveTransformationTestHooks;
    archiveProjectionPort?: PlanningArchiveProjectionPort;
  } = {},
): ArchiveTransformation {
  assertEligibilityCurrent(eligibility);
  assertEligibilityArtifactManifest(eligibility);
  const archiveProjectionPort =
    options.archiveProjectionPort ??
    createOpenSpecPlanningArchiveProjectionPort();
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw archiveError(
      'ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'A trusted temporary directory is required for archive.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-archive-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(eligibility.repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      eligibility.head,
    ]);
    worktreeAdded = true;
    assertDetachedWorktree(worktree, eligibility);
    const context = archiveProjectionContext(eligibility, worktree);
    let projection: PlanningArchiveProjection;
    try {
      const readiness = inspectPlanningArchiveReadiness(
        archiveProjectionPort,
        context,
      );
      if (!readiness.ready) {
        throw archiveError(
          'ARCHIVE_PROVIDER_NOT_READY',
          'The bound planning provider is not ready to prepare archive projection.',
          { diagnostics: readiness.diagnostics },
        );
      }
      const invoke = () =>
        preparePlanningArchiveProjection(archiveProjectionPort, context);
      projection = options.testHooks?.aroundArchivePreparation
        ? options.testHooks.aroundArchivePreparation(invoke)
        : invoke();
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'
      ) {
        throw error;
      }
      throw archiveFailure(error);
    }
    const payload = archivePayloadFromProjection(
      projection,
      eligibility,
      options.now ?? (() => new Date()),
    );
    const registryProjection = reconcileArchivedWorkItems(
      worktree,
      eligibility.changeId,
      eligibility.archiveDestination,
      archiveReconciliationTimestamp(worktree, eligibility.head),
    );
    const handoffOutputPaths = refreshArchiveManagedHandoff(
      worktree,
      eligibility.head,
    );
    const result = verifyTransformation(
      worktree,
      eligibility,
      payload,
      projection.providerVersion,
      [...registryProjection.outputPaths, ...handoffOutputPaths].sort(
        compareCanonicalStrings,
      ),
    );
    const validate = () => {
      const validation = validatePlanningArchiveProjectedSpecs(
        archiveProjectionPort,
        context,
      );
      if (!validation.valid) {
        throw archiveError(
          'ARCHIVE_REBUILT_SPECS_INVALID',
          'Strict validation rejected rebuilt base specs.',
          withinDiagnosticBudget({ rejectedSpecs: validation.diagnostics })
            ? { rejectedSpecs: validation.diagnostics }
            : {},
        );
      }
    };
    if (options.testHooks?.aroundProjectedSpecValidation) {
      options.testHooks.aroundProjectedSpecValidation(validate);
    } else {
      validate();
    }
    assertTemporaryProjectionCurrent(worktree, eligibility, result);
    assertEligibilityCurrent(eligibility);
    return result;
  } finally {
    if (worktreeAdded) {
      runGit(eligibility.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function archiveReconciliationTimestamp(
  repositoryRoot: string,
  parentCommit: string,
): string {
  const value = runGit(repositoryRoot, [
    'show',
    '-s',
    '--format=%cI',
    parentCommit,
  ]).trim();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw archiveError(
      'ARCHIVE_RECONCILIATION_TIMESTAMP_INVALID',
      'Archive parent does not expose one deterministic commit timestamp.',
    );
  }
  return parsed.toISOString();
}

export function refreshArchiveManagedHandoff(
  repositoryRoot: string,
  parentCommit: string,
): readonly string[] {
  const handoffPath = repositoryHandoffRelativePath(repositoryRoot);
  if (!completionDocumentPaths(repositoryRoot).includes(handoffPath)) {
    return Object.freeze([]);
  }
  const rendered = renderHandoffFromTrackedFacts(repositoryRoot);
  return readFileAtCommit(repositoryRoot, parentCommit, handoffPath) ===
    rendered
    ? Object.freeze([])
    : Object.freeze([handoffPath]);
}

/**
 * Execute a bound planning-provider archive projection only inside a
 * disposable detached worktree. Planning uses a byte-exact overlay of its
 * reviewed worktree artifacts; CI uses only the immutable planning commit.
 * The application retains all Git, ref, and authority ownership.
 */
export function createArchiveApplicabilityProjection(
  input: ArchiveApplicabilityProjectionInput,
  options: {
    archiveProjectionPort?: PlanningArchiveProjectionPort;
    readSystemDescriptionSnapshot?: (root: string) => SystemDescriptionSnapshot;
  } = {},
): SpecDeltaPreflightRecord {
  const repository = discoverRepository(input.repositoryRoot);
  const { baselineCommit, changeId, changeRoot, sourceCommit, validatedAt } =
    assertArchiveApplicabilityInput(repository, input);
  const activeRoot = `${changeRoot}/${changeId}`;
  const activeArtifactPaths = assertProjectionArtifactPaths(
    activeRoot,
    input.activeArtifactPaths,
  );
  const dependencies = createArchiveProjectionDependencies();
  const archiveProjectionPort =
    options.archiveProjectionPort ?? dependencies.archiveProjectionPort;
  const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
  if (!temporaryBase) {
    throw archiveError(
      'ARCHIVE_TEMPORARY_DIRECTORY_UNAVAILABLE',
      'A trusted temporary directory is required for archive applicability.',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'workflow-applicability-'),
  );
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  try {
    runGit(repository.repositoryRoot, [
      'worktree',
      'add',
      '--detach',
      worktree,
      sourceCommit,
    ]);
    worktreeAdded = true;
    assertProjectionWorktree(
      worktree,
      repository.gitCommonDirectory,
      sourceCommit,
    );
    if (input.source === 'worktree') {
      overlayPlanningArtifacts(
        repository.repositoryRoot,
        worktree,
        activeRoot,
        activeArtifactPaths,
      );
    } else {
      assertCommittedProjectionArtifacts(
        worktree,
        sourceCommit,
        activeRoot,
        activeArtifactPaths,
      );
    }

    const specInputs = readProjectionSpecInputs(
      worktree,
      activeRoot,
      activeArtifactPaths,
      options.readSystemDescriptionSnapshot ??
        dependencies.readSystemDescriptionSnapshot,
    );
    const reviewedArtifacts = readProjectionArtifactBindings(
      worktree,
      activeArtifactPaths,
    );
    for (const specInput of specInputs) {
      assertSpecDeltaPreconditions(
        specInput.capability,
        specInput.before,
        specInput.delta,
      );
    }
    const context = archiveApplicabilityProjectionContext(
      input,
      repository.repositoryRoot,
      worktree,
      sourceCommit,
    );
    let projection: PlanningArchiveProjection;
    try {
      const readiness = inspectPlanningArchiveReadiness(
        archiveProjectionPort,
        context,
      );
      if (!readiness.ready) {
        throw archiveError(
          'ARCHIVE_PROVIDER_NOT_READY',
          'The bound planning provider is not ready to prepare archive projection.',
          { diagnostics: readiness.diagnostics },
        );
      }
      projection = preparePlanningArchiveProjection(
        archiveProjectionPort,
        context,
      );
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'OPENSPEC_ARCHIVE_PAYLOAD_INVALID'
      ) {
        throw error;
      }
      throw archiveFailure(error);
    }
    const payload = publicArchivePayloadFromProjection(projection);
    if (!payload.specsUpdated || payload.totals === undefined) {
      throw archiveProjectionInvalid();
    }
    const archivedRoot = `${changeRoot}/archive/${payload.archivedAs}`;
    assertPreflightArchiveDestination(
      changeRoot,
      changeId,
      payload,
      archivedRoot,
    );
    assertArchivedProjectionArtifacts(
      worktree,
      activeRoot,
      archivedRoot,
      reviewedArtifacts,
    );
    const validation = validatePlanningArchiveProjectedSpecs(
      archiveProjectionPort,
      context,
    );
    if (!validation.valid) {
      throw archiveError(
        'ARCHIVE_REBUILT_SPECS_INVALID',
        'Strict validation rejected rebuilt base specs.',
        withinDiagnosticBudget({ rejectedSpecs: validation.diagnostics })
          ? { rejectedSpecs: validation.diagnostics }
          : {},
      );
    }

    assertProjectionChangedPaths(
      worktree,
      sourceCommit,
      activeRoot,
      archivedRoot,
      activeArtifactPaths,
      specInputs.map(({ baseSpecPath }) => baseSpecPath),
    );

    const totals: ArchiveTotals = {
      added: 0,
      modified: 0,
      removed: 0,
      renamed: 0,
    };
    const validatedBaseSpecDigests: Record<string, string> = {};
    for (const specInput of specInputs) {
      const projected = readPlainProjectionFile(
        worktree,
        specInput.baseSpecPath,
      );
      const verified = verifyProjectedSpecDeltaOutcome(
        specInput.capability,
        specInput.before,
        specInput.delta,
        projected,
      );
      for (const operation of Object.keys(totals) as Array<
        keyof ArchiveTotals
      >) {
        totals[operation] += verified.totals[operation];
      }
      validatedBaseSpecDigests[specInput.baseSpecPath] = sha256(
        specInput.before,
      );
    }
    if (canonicalJson(totals) !== canonicalJson(payload.totals)) {
      throw archiveError(
        'ARCHIVE_DELTA_OUTCOME_INVALID',
        'Public OpenSpec archive totals differ from the verified spec projection.',
      );
    }
    return {
      status: 'passed',
      validatedAt,
      validatedBaseCommit: baselineCommit,
      validatedBaseSpecDigests,
      validatorVersion: 'spec-delta-preflight-v3-public-archive',
    };
  } finally {
    if (worktreeAdded) {
      runGit(repository.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        worktree,
      ]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertArchiveApplicabilityInput(
  repository: ReturnType<typeof discoverRepository>,
  input: ArchiveApplicabilityProjectionInput,
): {
  baselineCommit: string;
  changeId: string;
  changeRoot: string;
  sourceCommit: string;
  validatedAt: string;
} {
  let changeId: string;
  let changeRoot: string;
  try {
    changeId = assertChangeId(input.changeId);
    changeRoot = normalizeChangedPath(input.changeRoot);
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires a canonical change identity and root.',
    );
  }
  const repositoryInput = path.resolve(input.repositoryRoot);
  if (
    fs.realpathSync(repositoryInput) !== repository.repositoryRealPath ||
    input.changeRoot !== changeRoot ||
    changeRoot.endsWith('/archive') ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baselineCommit) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sourceCommit) ||
    !['worktree', 'commit'].includes(input.source)
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires an exact repository, commit, and source boundary.',
    );
  }
  const baselineCommit = resolveExactCommit(
    repository.repositoryRoot,
    input.baselineCommit,
  );
  const sourceCommit = resolveExactCommit(
    repository.repositoryRoot,
    input.sourceCommit,
  );
  if (
    (input.source === 'worktree' &&
      (baselineCommit !== sourceCommit || repository.head !== sourceCommit)) ||
    (input.source === 'commit' &&
      canonicalJson(
        runGit(repository.repositoryRoot, [
          'show',
          '-s',
          '--format=%P',
          sourceCommit,
        ])
          .trim()
          .split(/\s+/)
          .filter(Boolean),
      ) !== canonicalJson([baselineCommit]))
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability source does not have the exact expected baseline.',
    );
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires a valid observation time.',
    );
  }
  return {
    baselineCommit,
    changeId,
    changeRoot,
    sourceCommit,
    validatedAt: now.toISOString(),
  };
}

function resolveExactCommit(repositoryRoot: string, value: string): string {
  let resolved: string;
  try {
    resolved = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${value}^{commit}`,
    ]).trim();
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability commit boundary does not resolve.',
    );
  }
  if (resolved !== value) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability commit boundary is not exact.',
    );
  }
  return resolved;
}

function assertProjectionArtifactPaths(
  activeRoot: string,
  values: readonly string[],
): string[] {
  let normalized: string[];
  try {
    normalized = values.map(normalizeChangedPath);
  } catch {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires exact canonical active artifact paths.',
    );
  }
  const sorted = [...normalized].sort(compareCanonicalStrings);
  if (
    sorted.length === 0 ||
    new Set(sorted).size !== sorted.length ||
    canonicalJson(normalized) !== canonicalJson(values) ||
    sorted.some(
      (relativePath) =>
        path.isAbsolute(relativePath) ||
        path.posix.normalize(relativePath) !== relativePath ||
        !relativePath.startsWith(`${activeRoot}/`) ||
        relativePath.includes('\\'),
    )
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires exact canonical active artifact paths.',
    );
  }
  return sorted;
}

function assertProjectionWorktree(
  worktree: string,
  gitCommonDirectory: string,
  sourceCommit: string,
): void {
  const git = discoverRepository(worktree);
  const expectedHead = runGit(worktree, ['rev-parse', sourceCommit]).trim();
  if (
    git.repositoryRoot !== worktree ||
    git.repositoryRealPath !== worktree ||
    git.gitCommonDirectory !== gitCommonDirectory ||
    git.branch !== null ||
    git.head !== expectedHead ||
    git.statusEntries.length > 0
  ) {
    throw archiveError(
      'ARCHIVE_WORKTREE_INVALID',
      'Archive applicability did not start from the exact detached source commit.',
    );
  }
}

function overlayPlanningArtifacts(
  repositoryRoot: string,
  worktree: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
): void {
  const targetRoot = path.join(worktree, activeRoot);
  assertInsideDirectory(worktree, targetRoot);
  assertPlainDirectoryChain(worktree, path.dirname(targetRoot));
  const existingTarget = fs.lstatSync(targetRoot, { throwIfNoEntry: false });
  if (
    existingTarget !== undefined &&
    (!existingTarget.isDirectory() || existingTarget.isSymbolicLink())
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability target root is not one plain directory.',
    );
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const relativePath of activeArtifactPaths) {
    const target = path.join(worktree, relativePath);
    assertInsideDirectory(worktree, target);
    const { bytes, mode } = readPlainProjectionBytes(
      repositoryRoot,
      relativePath,
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, {
      flag: 'wx',
      mode,
    });
  }
}

function assertCommittedProjectionArtifacts(
  worktree: string,
  sourceCommit: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
): void {
  const entries = runGit(worktree, [
    'ls-tree',
    '-r',
    '-z',
    sourceCommit,
    '--',
    `:(literal)${activeRoot}`,
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^100644 blob [0-9a-f]{40,64}\t(.+)$/.exec(entry);
      if (!match) {
        throw archiveError(
          'ARCHIVE_APPLICABILITY_INPUT_INVALID',
          'Immutable planning commit contains a non-plain artifact.',
        );
      }
      return match[1];
    })
    .sort(compareCanonicalStrings);
  if (canonicalJson(entries) !== canonicalJson(activeArtifactPaths)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Immutable planning commit does not contain the exact active artifact manifest.',
    );
  }
}

function readProjectionArtifactBindings(
  worktree: string,
  activeArtifactPaths: readonly string[],
): ReadonlyMap<string, { digest: string; mode: number }> {
  return new Map(
    activeArtifactPaths.map((relativePath) => {
      const artifact = readPlainProjectionBytes(
        worktree,
        relativePath,
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      );
      if ((artifact.mode & 0o111) !== 0) {
        throw archiveError(
          'ARCHIVE_TRANSFORMATION_TREE_INVALID',
          `Archive applicability artifact is executable: ${relativePath}.`,
        );
      }
      return [
        relativePath,
        { digest: sha256(artifact.bytes), mode: artifact.mode },
      ];
    }),
  );
}

function assertArchivedProjectionArtifacts(
  worktree: string,
  activeRoot: string,
  archivedRoot: string,
  reviewedArtifacts: ReadonlyMap<string, { digest: string; mode: number }>,
): void {
  for (const [relativePath, expected] of reviewedArtifacts) {
    const archivedPath = `${archivedRoot}/${relativePath.slice(activeRoot.length + 1)}`;
    const actual = readPlainProjectionBytes(
      worktree,
      archivedPath,
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
    );
    if (
      sha256(actual.bytes) !== expected.digest ||
      actual.mode !== expected.mode
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        `Public OpenSpec archive changed a reviewed planning artifact: ${relativePath}.`,
      );
    }
  }
}

function readProjectionSpecInputs(
  worktree: string,
  activeRoot: string,
  activeArtifactPaths: readonly string[],
  readSystemDescription: (root: string) => SystemDescriptionSnapshot,
): Array<{
  capability: string;
  delta: string;
  before: string;
  baseSpecPath: string;
}> {
  const prefix = `${activeRoot}/specs/`;
  const deltaPaths = activeArtifactPaths.filter(
    (relativePath) =>
      relativePath.startsWith(prefix) && relativePath.endsWith('/spec.md'),
  );
  if (deltaPaths.length === 0) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires at least one current delta specification.',
    );
  }
  const colocated = readSystemSpecDeltaInputs(
    readSystemDescription(worktree),
    deltaPaths,
  );
  if (colocated) return colocated;
  return deltaPaths.map((deltaPath) => {
    const capability = deltaPath.slice(prefix.length, -'/spec.md'.length);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_INVALID',
        `Delta specification has a non-canonical capability: ${deltaPath}.`,
      );
    }
    const baseSpecPath = `openspec/specs/${capability}/spec.md`;
    return {
      capability,
      delta: readPlainProjectionFile(worktree, deltaPath),
      before: readOptionalPlainProjectionFile(worktree, baseSpecPath) ?? '',
      baseSpecPath,
    };
  });
}

function assertPreflightArchiveDestination(
  changeRoot: string,
  changeId: string,
  payload: PublicArchivePayload,
  archivedRoot: string,
): void {
  const suffix = `-${changeId}`;
  const date = payload.archivedAs.endsWith(suffix)
    ? payload.archivedAs.slice(0, -suffix.length)
    : '';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsed.getTime()) ||
    utcDate(parsed) !== date ||
    path.posix.dirname(archivedRoot) !== `${changeRoot}/archive` ||
    payload.archivePath !== archivedRoot
  ) {
    throw archiveProjectionInvalid();
  }
}

function assertProjectionChangedPaths(
  worktree: string,
  sourceCommit: string,
  activeRoot: string,
  archivedRoot: string,
  activeArtifactPaths: readonly string[],
  baseSpecPaths: readonly string[],
): void {
  const sourceActivePaths = runGit(worktree, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    sourceCommit,
    '--',
    `:(literal)${activeRoot}`,
  ])
    .split('\0')
    .filter(Boolean)
    .sort(compareCanonicalStrings);
  const archivedArtifactPaths = activeArtifactPaths.map(
    (relativePath) =>
      `${archivedRoot}/${relativePath.slice(activeRoot.length + 1)}`,
  );
  const changedPaths = listChangedPaths(worktree, sourceCommit);
  const allowed = new Set([
    ...sourceActivePaths,
    ...activeArtifactPaths,
    ...archivedArtifactPaths,
    ...baseSpecPaths,
  ]);
  if (
    changedPaths.some((relativePath) => !allowed.has(relativePath)) ||
    [...sourceActivePaths, ...archivedArtifactPaths, ...baseSpecPaths].some(
      (relativePath) => !changedPaths.includes(relativePath),
    )
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_PATHS_INVALID',
      'Public OpenSpec applicability projection changed paths outside its exact planning targets.',
      { changedPaths },
    );
  }
}

function readOptionalPlainProjectionFile(
  root: string,
  relativePath: string,
): string | undefined {
  const target = path.join(root, relativePath);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  return readPlainProjectionFile(root, relativePath, stats);
}

function readPlainProjectionFile(
  root: string,
  relativePath: string,
  knownStats?: fs.Stats,
): string {
  return readPlainProjectionBytes(
    root,
    relativePath,
    'ARCHIVE_TRANSFORMATION_TREE_INVALID',
    knownStats,
  ).bytes.toString('utf8');
}

function readPlainProjectionBytes(
  root: string,
  relativePath: string,
  errorCode: string,
  knownStats?: fs.Stats,
): { bytes: Buffer; mode: number } {
  const target = path.join(root, relativePath);
  assertInsideDirectory(root, target);
  assertPlainDirectoryChain(root, path.dirname(target));
  const pathBefore = knownStats ?? fs.lstatSync(target);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1
  ) {
    throw archiveError(
      errorCode,
      `Archive applicability file is not one plain file: ${relativePath}.`,
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw archiveError(
      errorCode,
      `Archive applicability file could not be opened safely: ${relativePath}.`,
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(target);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      BigInt(pathBefore.dev) !== before.dev ||
      BigInt(pathBefore.ino) !== before.ino ||
      BigInt(pathBefore.mode) !== before.mode ||
      BigInt(pathBefore.size) !== before.size ||
      !sameBigIntSnapshot(before, after) ||
      BigInt(pathAfter.dev) !== after.dev ||
      BigInt(pathAfter.ino) !== after.ino ||
      BigInt(pathAfter.mode) !== after.mode ||
      BigInt(pathAfter.size) !== after.size ||
      pathAfter.nlink !== 1
    ) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_CHANGED',
        `Archive applicability file changed while it was read: ${relativePath}.`,
      );
    }
    assertPlainDirectoryChain(root, path.dirname(target));
    return { bytes, mode: Number(before.mode & 0o777n) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameBigIntSnapshot(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function assertPlainDirectoryChain(root: string, directory: string): void {
  const canonicalRoot = fs.realpathSync(root);
  if (canonicalRoot !== path.resolve(root)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability root is not canonical.',
    );
  }
  assertInsideDirectory(root, directory);
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw archiveError(
        'ARCHIVE_APPLICABILITY_INPUT_INVALID',
        'Archive applicability path has a non-plain parent directory.',
      );
    }
  }
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability path has a non-canonical parent directory.',
    );
  }
}

function assertInsideDirectory(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability path escapes its repository root.',
    );
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verifyTransformation(
  worktree: string,
  eligibility: ArchiveEligibility,
  payload: ArchivePayload,
  providerVersion: string,
  managedOutputPaths: readonly string[],
): ArchiveTransformation {
  const activeRoot = eligibility.activeRoot;
  const activeFiles = [...eligibility.activeArtifactPaths].sort();
  if (
    JSON.stringify(listTreeFiles(worktree, eligibility.head, activeRoot)) !==
    JSON.stringify(activeFiles)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest differs from the active change tree.',
    );
  }
  const archivedFiles = listPlainArchiveFiles(
    worktree,
    eligibility.archiveDestination,
  );
  const expectedArchivedFiles = activeFiles.map(
    (filePath) =>
      `${eligibility.archiveDestination}/${filePath.slice(activeRoot.length + 1)}`,
  );
  const archivedArtifactDigests: Record<string, string> = {};
  if (JSON.stringify(archivedFiles) !== JSON.stringify(expectedArchivedFiles)) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archived files do not exactly mirror the active change.',
    );
  }
  for (let index = 0; index < activeFiles.length; index += 1) {
    const before = readFileAtCommit(
      worktree,
      eligibility.head,
      activeFiles[index],
    );
    const after = fs.readFileSync(path.join(worktree, archivedFiles[index]));
    const digest = crypto.createHash('sha256').update(after).digest('hex');
    if (
      before === undefined ||
      !Buffer.from(before).equals(after) ||
      eligibility.artifactDigests[activeFiles[index]] !== digest
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        'Archived file content differs from the eligible active change.',
      );
    }
    archivedArtifactDigests[
      archivedFiles[index].slice(eligibility.archiveDestination.length + 1)
    ] = digest;
  }

  const changedPaths = listChangedPaths(worktree, eligibility.head);
  const allowed = new Set([
    ...activeFiles,
    ...expectedArchivedFiles,
    ...eligibility.targetPaths.filter(isBaseSpecificationPath),
    ...managedOutputPaths,
  ]);
  if (
    changedPaths.some((changedPath) => !allowed.has(changedPath)) ||
    activeFiles.some((activeFile) => !changedPaths.includes(activeFile)) ||
    expectedArchivedFiles.some(
      (archivedFile) => !changedPaths.includes(archivedFile),
    ) ||
    managedOutputPaths.some((outputPath) => !changedPaths.includes(outputPath))
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_PATHS_INVALID',
      'Archive transformation changed paths outside its exact targets.',
      { changedPaths },
    );
  }
  const baseSpecPaths = changedPaths.filter(isBaseSpecificationPath);
  for (const baseSpecPath of baseSpecPaths) {
    assertPlainArchiveOutputFile(worktree, baseSpecPath);
  }
  if (payload.specsUpdated !== baseSpecPaths.length > 0) {
    throw archiveError(
      'OPENSPEC_ARCHIVE_PAYLOAD_INVALID',
      'OpenSpec spec-update output contradicts the Git transformation.',
    );
  }

  stageTemporaryProjection(worktree, eligibility.head, changedPaths);
  const patch = runGit(worktree, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    eligibility.head,
    '--',
    ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  if (!patch || !/^diff --git /m.test(patch)) {
    throw archiveError(
      'ARCHIVE_PATCH_INVALID',
      'Archive did not produce a non-empty full-index patch.',
    );
  }
  const tree = runGit(worktree, ['write-tree']).trim();
  return {
    changeId: eligibility.changeId,
    archiveName: payload.archivedAs,
    archivePath: eligibility.archiveDestination,
    baseSpecPaths,
    changedPaths,
    patch,
    patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
    tree,
    archivedArtifactDigests,
    providerVersion,
    ...(payload.totals ? { totals: payload.totals } : {}),
  };
}

function assertTemporaryProjectionCurrent(
  worktree: string,
  eligibility: ArchiveEligibility,
  result: ArchiveTransformation,
): void {
  if (
    JSON.stringify(listChangedPaths(worktree, eligibility.head)) !==
    JSON.stringify(result.changedPaths)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_CHANGED',
      'Temporary archive projection changed during validation.',
    );
  }
  const patch = runGit(worktree, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    eligibility.head,
    '--',
    ...result.changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  if (
    crypto.createHash('sha256').update(patch).digest('hex') !==
    result.patchDigest
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_CHANGED',
      'Temporary archive patch changed during validation.',
    );
  }
}

function stageTemporaryProjection(
  worktree: string,
  head: string,
  changedPaths: string[],
): void {
  runGit(worktree, [
    'add',
    '-A',
    '--',
    ...changedPaths.map((changedPath) => `:(literal)${changedPath}`),
  ]);
  const staged = runGit(worktree, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '-z',
    head,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(staged) !== JSON.stringify(changedPaths)) {
    throw archiveError(
      'ARCHIVE_PATCH_INVALID',
      'Temporary index does not contain the exact archive projection.',
    );
  }
}

function archiveProjectionContext(
  eligibility: ArchiveEligibility,
  projectionRoot: string,
): PlanningArchiveProjectionContext {
  if (
    eligibility.planningProvider.binding.planningRoot !== eligibility.activeRoot
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive planning-provider binding does not own the exact active change root.',
    );
  }
  return {
    repositoryRoot: eligibility.repositoryRealPath,
    projectionRoot: fs.realpathSync(projectionRoot),
    sourceRevision: eligibility.head,
    changeId: eligibility.changeId,
    mode: 'projection',
    planningProvider: eligibility.planningProvider,
  };
}

function archiveApplicabilityProjectionContext(
  input: ArchiveApplicabilityProjectionInput,
  repositoryRoot: string,
  projectionRoot: string,
  sourceRevision: string,
): PlanningArchiveProjectionContext {
  if (
    input.planningProvider.binding.planningRoot !==
    `${input.changeRoot}/${input.changeId}`
  ) {
    throw archiveError(
      'ARCHIVE_APPLICABILITY_INPUT_INVALID',
      'Archive applicability requires one exact planning-provider binding root.',
    );
  }
  return {
    repositoryRoot: fs.realpathSync(repositoryRoot),
    projectionRoot: fs.realpathSync(projectionRoot),
    sourceRevision,
    changeId: input.changeId,
    mode: 'projection',
    planningProvider: input.planningProvider,
  };
}

function archivePayloadFromProjection(
  projection: PlanningArchiveProjection,
  eligibility: ArchiveEligibility,
  now: () => Date,
): ArchivePayload {
  const parsed = publicArchivePayloadFromProjection(projection);
  const expectedName = path.basename(eligibility.archiveDestination);
  if (
    !parsed.specsUpdated ||
    parsed.archivedAs !== expectedName ||
    parsed.archivePath !== eligibility.archiveDestination
  ) {
    assertAdjacentUtcRollover(parsed, eligibility, expectedName, now);
  }
  return {
    archivedAs: parsed.archivedAs,
    specsUpdated: parsed.specsUpdated,
    ...(parsed.totals ? { totals: parsed.totals } : {}),
  };
}

function publicArchivePayloadFromProjection(
  projection: PlanningArchiveProjection,
): PublicArchivePayload {
  return {
    archivedAs: projection.archiveName,
    archivePath: projection.archivePath,
    specsUpdated: projection.specsUpdated,
    ...(projection.totals === undefined ? {} : { totals: projection.totals }),
  };
}

function assertAdjacentUtcRollover(
  payload: PublicArchivePayload,
  eligibility: ArchiveEligibility,
  expectedName: string,
  now: () => Date,
): never {
  const suffix = `-${eligibility.changeId}`;
  const archiveParent = `${eligibility.changeRoot}/archive`;
  const expectedDate = expectedName.endsWith(suffix)
    ? expectedName.slice(0, -suffix.length)
    : '';
  const rolloverDate = nextUtcDate(expectedDate);
  const rolloverName = `${rolloverDate}${suffix}`;
  const rolloverPath = `${archiveParent}/${rolloverName}`;
  if (
    path.posix.dirname(eligibility.archiveDestination) !== archiveParent ||
    payload.archivedAs !== rolloverName ||
    payload.archivePath !== rolloverPath
  ) {
    throw archiveProjectionInvalid();
  }

  const observedAt = now();
  if (
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime()) ||
    utcDate(observedAt) !== rolloverDate
  ) {
    throw archiveProjectionInvalid();
  }
  throw archiveError(
    'ARCHIVE_UTC_DATE_ROLLOVER',
    'Archive output crossed to the adjacent UTC date during this operation.',
    { expectedDate, observedDate: rolloverDate },
  );
}

function nextUtcDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw archiveProjectionInvalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || utcDate(date) !== value) {
    throw archiveProjectionInvalid();
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return utcDate(date);
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertDetachedWorktree(
  worktree: string,
  eligibility: ArchiveEligibility,
): void {
  const git = discoverRepository(worktree);
  if (
    git.repositoryRoot !== worktree ||
    git.repositoryRealPath !== worktree ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== null ||
    git.head !== eligibility.head ||
    git.tree !== eligibility.tree ||
    git.statusEntries.length > 0
  ) {
    throw archiveError(
      'ARCHIVE_WORKTREE_INVALID',
      'Temporary archive worktree is not the exact detached baseline.',
    );
  }
}

function assertEligibilityCurrent(eligibility: ArchiveEligibility): void {
  const git = discoverRepository(eligibility.repositoryRoot);
  if (
    git.repositoryRoot !== eligibility.repositoryRoot ||
    git.repositoryRealPath !== eligibility.repositoryRealPath ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== eligibility.branch ||
    git.head !== eligibility.head ||
    git.tree !== eligibility.tree ||
    git.statusEntries.length > 0 ||
    fingerprintRepositoryWorktree(git.repositoryRoot, git.head) !==
      eligibility.fingerprint
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Real repository state changed after archive eligibility.',
    );
  }
}

function assertEligibilityArtifactManifest(
  eligibility: ArchiveEligibility,
): void {
  const activeRoot = `${eligibility.changeRoot}/${eligibility.changeId}`;
  const required = requiredPlanningArtifactPaths(
    eligibility.changeRoot,
    eligibility.changeId,
    eligibility.schemaName,
    eligibility.currentSchemaName,
  );
  try {
    assertPlanningPaths(
      eligibility.changeRoot,
      eligibility.changeId,
      eligibility.activeArtifactPaths,
      [],
      eligibility.schemaName,
      eligibility.currentSchemaName,
    );
  } catch {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest does not match its selected schema.',
    );
  }
  if (
    eligibility.activeRoot !== activeRoot ||
    required.some(
      (requiredPath) => !eligibility.activeArtifactPaths.includes(requiredPath),
    ) ||
    !eligibility.activeArtifactPaths.some(
      (artifactPath) =>
        artifactPath.startsWith(`${activeRoot}/specs/`) &&
        artifactPath.endsWith('/spec.md'),
    ) ||
    JSON.stringify(
      listTreeFiles(eligibility.repositoryRoot, eligibility.head, activeRoot),
    ) !== JSON.stringify(eligibility.activeArtifactPaths)
  ) {
    throw archiveError(
      'ARCHIVE_TRANSFORMATION_TREE_INVALID',
      'Archive eligibility manifest differs from the active change tree.',
    );
  }
  for (const artifactPath of eligibility.activeArtifactPaths) {
    const content = readFileAtCommit(
      eligibility.repositoryRoot,
      eligibility.head,
      artifactPath,
    );
    if (
      content === undefined ||
      crypto.createHash('sha256').update(content).digest('hex') !==
        eligibility.artifactDigests[artifactPath]
    ) {
      throw archiveError(
        'ARCHIVE_TRANSFORMATION_TREE_INVALID',
        'Archive eligibility manifest digest differs from the active change.',
      );
    }
  }
}

function listTreeFiles(
  repository: string,
  commit: string,
  root: string,
): string[] {
  return runGit(repository, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    commit,
    '--',
    `:(literal)${root}`,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
}

function archiveFailure(error: unknown) {
  return workflowError(
    'OPENSPEC_ARCHIVE_FAILED',
    'Bound planning-provider archive projection failed inside the temporary worktree.',
    error instanceof WorkflowError ? error.exitCode : ExitCode.verification,
    { details: boundedArchiveCauseDiagnostic(error) },
  );
}

function archiveProjectionInvalid(): WorkflowError {
  return archiveError(
    'OPENSPEC_ARCHIVE_PAYLOAD_INVALID',
    'Planning-provider archive projection returned an invalid identity or destination.',
  );
}

function archiveError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return workflowError(code, message, ExitCode.verification, { details });
}
