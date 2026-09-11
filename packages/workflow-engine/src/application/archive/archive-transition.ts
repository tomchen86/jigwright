import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
import type { ArchiveEligibilityReplayServices } from '../../modules/assurance/commit-replay/ci-archive.ts';
import type { PlanningArchiveSourcePolicy } from '../../modules/planning-provider/planning-archive-projection-port.ts';
import type { ReadSystemSpecDeltaInputs } from '../../modules/source/system-spec-deltas.ts';
import type { CollaborationGrantCodec } from '../../modules/authority/collaboration-grant-codec.ts';
import type { ArchivedWorkItemReconciler } from '../../modules/governance-intake/work-registry-contracts.ts';
/**
 * Commits verified archive transformations and recovers their immutable
 * transition evidence.
 *
 * Invariants:
 * - An accepted archive report must match the exact commit parent, tree,
 *   message and changed paths.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  withArchiveEligibility,
  type ArchiveEligibility,
} from './archive-eligibility.ts';
import { verifyArchiveDeltaOutcomes } from '../../runtime/repository-transaction/archive-delta-verifier.ts';
import {
  listArchiveReports,
  readArchiveReport,
  writeArchiveReport,
  type ArchiveTransitionReport,
} from '../../runtime/storage-journal/archive-report.ts';
import {
  createArchiveTransformation,
  type ArchiveTransformationTestHooks,
  type ArchiveTransformation,
} from './archive-transformation.ts';
import { loadWorkflowConfig } from '../../runtime/repository-observation/workflow-configuration.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  archiveCommitMessage,
  commitChangedPaths,
  commitFacts,
  createArchiveCommitObject,
  listStagedPaths,
  updateManagedRef,
  updateManagedRefs,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  discoverRepository,
  fingerprintRepositoryWorktree,
  listChangedPaths,
  LOCAL_PROTECTED_BASE_REF,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { runtimePaths } from '../../runtime/session-workspace/session-store.ts';

export type ArchiveTransitionResult = {
  status: 'committed' | 'already-archived';
  changeId: string;
  archivePath: string;
  commitHash: string;
  reportId: string;
  changedPaths: string[];
};

export type ArchiveTransitionTestHooks = ArchiveTransformationTestHooks & {
  now?(): Date;
  expectedRemoteBase?: Readonly<{
    name: 'origin';
    trackingRef: string;
    commit: string;
    tree: string;
  }>;
  beforeApply?(context: { repositoryRoot: string }): void;
  beforeRefUpdate?(context: {
    repositoryRoot: string;
    headRef: string;
    commitHash: string;
    reportId: string;
  }): void;
};

export type ArchiveTransitionEvidenceExpectation = Readonly<{
  changeId: string;
  parentCommit: string;
  commitHash: string;
  reportId?: string;
}>;

export type VerifiedArchiveTransitionEvidence = Readonly<{
  reportId: string;
  report: ArchiveTransitionReport;
}>;

export function commitArchiveTransition(
  planningExecution: PlanningTransitionExecutionServices,
  sourcePolicy: PlanningArchiveSourcePolicy,
  archiveReplayServices: ArchiveEligibilityReplayServices,
  collaborationGrants: Pick<
    CollaborationGrantCodec,
    'assertUniqueCollaborationGrantUses'
  >,
  renderTrackedHandoff: (repositoryRoot: string) => string,
  reconcileArchivedWorkItems: ArchivedWorkItemReconciler,
  cwd: string,
  requestedChangeId: string,
  environment: NodeJS.ProcessEnv = process.env,
  testHooks: ArchiveTransitionTestHooks = {},
): ArchiveTransitionResult {
  const existing = findExistingArchive(cwd, requestedChangeId);
  if (existing) return existing;
  const now = testHooks.now ?? (() => new Date());
  return withArchiveEligibility(
    planningExecution,
    archiveReplayServices,
    collaborationGrants,
    cwd,
    requestedChangeId,
    (eligibility, assertOwned, refreshEligibility) => {
      assertExpectedRemoteBase(eligibility, testHooks.expectedRemoteBase);
      try {
        return commitEligibleArchive(
          sourcePolicy,
          renderTrackedHandoff,
          reconcileArchivedWorkItems,
          eligibility,
          environment,
          testHooks,
          assertOwned,
          now,
        );
      } catch (error) {
        const rolloverDate = archiveRolloverDate(error);
        if (rolloverDate === undefined) throw error;
        const refreshed = refreshEligibility(
          new Date(`${rolloverDate}T00:00:00.000Z`),
        );
        return commitEligibleArchive(
          sourcePolicy,
          renderTrackedHandoff,
          reconcileArchivedWorkItems,
          refreshed,
          environment,
          testHooks,
          assertOwned,
          now,
        );
      }
    },
    now(),
  );
}

/**
 * Read one content-addressed archive report and replay its exact immutable Git
 * commit identity. Supplying no report id is reserved for recovery callers and
 * requires one unambiguous report for the expected archive commit.
 */
export function readVerifiedArchiveTransitionEvidence(
  repositoryRoot: string,
  expectation: ArchiveTransitionEvidenceExpectation,
): VerifiedArchiveTransitionEvidence {
  try {
    const directory = archiveReportsDirectory(repositoryRoot);
    const matches =
      expectation.reportId === undefined
        ? listArchiveReports(directory, expectation.changeId).filter(
            ({ report }) => report.commitHash === expectation.commitHash,
          )
        : [
            {
              reportId: expectation.reportId,
              report: readArchiveReport(directory, expectation.reportId),
            },
          ];
    if (matches.length !== 1) throw new Error('ambiguous archive report');
    const [{ reportId, report }] = matches;
    const facts = commitFacts(repositoryRoot, expectation.commitHash);
    if (
      report.changeId !== expectation.changeId ||
      report.parent !== expectation.parentCommit ||
      report.commitHash !== expectation.commitHash ||
      facts.hash !== expectation.commitHash ||
      JSON.stringify(facts.parents) !==
        JSON.stringify([expectation.parentCommit]) ||
      facts.tree !== report.tree ||
      facts.message !== `${archiveCommitMessage(expectation.changeId)}\n` ||
      (report.localProtectedBase !== undefined &&
        !isAncestor(
          repositoryRoot,
          report.localProtectedBase.commit,
          report.parent,
        )) ||
      JSON.stringify(commitChangedPaths(repositoryRoot, facts.hash)) !==
        JSON.stringify(report.changedPaths)
    ) {
      throw new Error('archive report does not match immutable Git facts');
    }
    return Object.freeze({ reportId, report });
  } catch {
    throw archiveError(
      'ARCHIVE_REPORT_STALE',
      'Archive evidence does not match one exact immutable commit.',
    );
  }
}

/**
 * Inspect an already-applied archive transition using the same report and
 * immutable Git replay as archive idempotency. This read-only surface never
 * acquires the archive lock or authors a transition.
 */
export function inspectExistingArchiveTransition(
  cwd: string,
  changeId: string,
): ArchiveTransitionResult | undefined {
  return findExistingArchive(cwd, changeId);
}

function commitEligibleArchive(
  sourcePolicy: PlanningArchiveSourcePolicy,
  renderTrackedHandoff: (repositoryRoot: string) => string,
  reconcileArchivedWorkItems: ArchivedWorkItemReconciler,
  eligibility: ArchiveEligibility,
  environment: NodeJS.ProcessEnv,
  testHooks: ArchiveTransitionTestHooks,
  assertOwned: () => void,
  now: () => Date,
): ArchiveTransitionResult {
  assertExpectedRemoteBase(eligibility, testHooks.expectedRemoteBase);
  const transformation = createArchiveTransformation(
    sourcePolicy,
    renderTrackedHandoff,
    reconcileArchivedWorkItems,
    eligibility,
    {
      now,
      testHooks,
    },
  );
  const delta = verifyArchiveDeltaOutcomesForTransition(
    sourcePolicy.readSystemSpecDeltaInputs,
    eligibility,
    transformation,
  );
  const headRef = `refs/heads/${eligibility.branch}`;
  if (
    runGit(
      eligibility.repositoryRoot,
      ['symbolic-ref', '--quiet', 'HEAD'],
      true,
    ).trim() !== headRef
  ) {
    throw archiveError(
      'ARCHIVE_HEAD_CHANGED',
      'Archive branch reference is not stable.',
    );
  }
  const commitHash = createArchiveCommitObject(
    eligibility.repositoryRoot,
    transformation.tree,
    eligibility.head,
    eligibility.changeId,
    environment,
  );
  assertArchiveCommit(
    eligibility.repositoryRoot,
    eligibility,
    transformation,
    commitHash,
  );
  const reportsDirectory = archiveReportsDirectory(eligibility.repositoryRoot);
  const report: ArchiveTransitionReport = {
    schemaVersion: 1,
    kind: 'archive-transition',
    createdAt: new Date().toISOString(),
    changeId: eligibility.changeId,
    archivePath: transformation.archivePath,
    parent: eligibility.head,
    tree: transformation.tree,
    commitHash,
    patch: transformation.patch,
    patchDigest: transformation.patchDigest,
    changedPaths: transformation.changedPaths,
    logicalIdentity: logicalIdentity(
      eligibility,
      transformation,
      delta.promotedSpecDigests,
    ),
    contractDigest: eligibility.contractDigest,
    promotedSpecDigests: delta.promotedSpecDigests,
    archivedArtifactDigests: transformation.archivedArtifactDigests,
    ...(eligibility.baseRef === LOCAL_PROTECTED_BASE_REF
      ? {
          localProtectedBase: {
            ref: LOCAL_PROTECTED_BASE_REF,
            commit: eligibility.base,
          },
        }
      : {}),
  };
  const reportId = writeArchiveReport(reportsDirectory, report);
  const patchDirectory = path.join(
    eligibility.gitCommonDirectory,
    loadWorkflowConfig(eligibility.repositoryRoot).runtimeDirectory,
    'archive-patches',
  );
  ensurePlainDirectory(patchDirectory);
  const patchPath = path.join(patchDirectory, `${report.patchDigest}.patch`);
  writePatchOnce(patchPath, report.patch);

  let applied = false;
  let refUpdated = false;
  try {
    testHooks.beforeApply?.({ repositoryRoot: eligibility.repositoryRoot });
    assertOwned();
    assertRealState(eligibility, transformation, false);
    runGit(eligibility.repositoryRoot, [
      'apply',
      '--check',
      '--binary',
      '--index',
      patchPath,
    ]);
    runGit(eligibility.repositoryRoot, [
      'apply',
      '--binary',
      '--index',
      patchPath,
    ]);
    applied = true;
    assertRealState(eligibility, transformation, true);
    assertReportCurrent(reportsDirectory, reportId, report);
    testHooks.beforeRefUpdate?.({
      repositoryRoot: eligibility.repositoryRoot,
      headRef,
      commitHash,
      reportId,
    });
    assertOwned();
    assertExpectedRemoteBase(eligibility, testHooks.expectedRemoteBase);
    assertRealState(eligibility, transformation, true);
    assertReportCurrent(reportsDirectory, reportId, report);
    if (
      runGit(
        eligibility.repositoryRoot,
        ['rev-parse', headRef],
        true,
      ).trim() !== eligibility.head
    ) {
      throw archiveError(
        'ARCHIVE_HEAD_CHANGED',
        'Archive branch changed before compare-and-swap.',
      );
    }
    if (report.localProtectedBase === undefined) {
      updateManagedRef(
        eligibility.repositoryRoot,
        eligibility.head,
        commitHash,
        headRef,
      );
    } else {
      updateManagedRefs(eligibility.repositoryRoot, [
        { ref: headRef, expectedHead: eligibility.head, commitHash },
        {
          ref: report.localProtectedBase.ref,
          expectedHead: report.localProtectedBase.commit,
          commitHash,
        },
      ]);
    }
    refUpdated = true;
    assertLocalArchivePublished(eligibility.repositoryRoot, report);
    if (
      discoverRepository(eligibility.repositoryRoot).statusEntries.length > 0
    ) {
      throw archiveError(
        'ARCHIVE_POSTCONDITION_FAILED',
        'Archive commit did not leave a clean repository.',
      );
    }
    return resultFromReport('committed', reportId, report);
  } catch (error) {
    if (applied && !refUpdated) rollbackPatch(eligibility, patchPath);
    throw error;
  }
}

function assertExpectedRemoteBase(
  eligibility: ArchiveEligibility,
  expected: ArchiveTransitionTestHooks['expectedRemoteBase'],
): void {
  if (expected === undefined) return;
  const observedCommit = runGit(
    eligibility.repositoryRoot,
    ['rev-parse', '--verify', `${expected.trackingRef}^{commit}`],
    true,
  ).trim();
  const observedTree = runGit(
    eligibility.repositoryRoot,
    ['rev-parse', '--verify', `${expected.trackingRef}^{tree}`],
    true,
  ).trim();
  if (
    expected.name !== 'origin' ||
    eligibility.baseRef !== expected.trackingRef ||
    eligibility.base !== expected.commit ||
    observedCommit !== expected.commit ||
    observedTree !== expected.tree
  ) {
    throw archiveError(
      'ARCHIVE_REMOTE_BASE_CHANGED',
      'The exact protected remote-tracking base changed during archive authorization.',
    );
  }
}

function archiveRolloverDate(error: unknown): string | undefined {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'ARCHIVE_UTC_DATE_ROLLOVER'
  ) {
    return undefined;
  }
  const observedDate = error.details?.observedDate;
  if (
    typeof observedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(observedDate)
  ) {
    throw error;
  }
  const parsed = new Date(`${observedDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== observedDate
  ) {
    throw error;
  }
  return observedDate;
}

/**
 * The shared verifier names an inapplicable declaration precisely for plan
 * preflight callers. Archive's public transition predates that core and keeps
 * its stable outer outcome code while retaining the structured inner fault.
 */
function verifyArchiveDeltaOutcomesForTransition(
  readSystemSpecDeltaInputs: ReadSystemSpecDeltaInputs,
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
) {
  try {
    return verifyArchiveDeltaOutcomes(
      readSystemSpecDeltaInputs,
      eligibility.repositoryRoot,
      eligibility,
      transformation,
    );
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code !== 'SPEC_DELTA_NOT_APPLICABLE'
    ) {
      throw error;
    }
    throw workflowError(
      'ARCHIVE_DELTA_OUTCOME_INVALID',
      'Archived base specifications do not match declared delta operations.',
      ExitCode.verification,
      {
        details: {
          causeCode: error.code,
          ...(error.details ?? {}),
        },
      },
    );
  }
}

function assertRealState(
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  applied: boolean,
): void {
  const git = discoverRepository(eligibility.repositoryRoot);
  if (git.head !== eligibility.head) {
    throw archiveError(
      'ARCHIVE_HEAD_CHANGED',
      'Archive branch changed before compare-and-swap.',
    );
  }
  const expectedPaths = applied ? transformation.changedPaths : [];
  if (
    git.repositoryRealPath !== eligibility.repositoryRealPath ||
    git.gitCommonDirectory !== eligibility.gitCommonDirectory ||
    git.branch !== eligibility.branch ||
    JSON.stringify(listChangedPaths(git.repositoryRoot, git.head)) !==
      JSON.stringify(expectedPaths) ||
    JSON.stringify(listStagedPaths(git.repositoryRoot, git.head)) !==
      JSON.stringify(expectedPaths) ||
    (!applied &&
      fingerprintRepositoryWorktree(git.repositoryRoot, git.head) !==
        eligibility.fingerprint) ||
    (applied &&
      runGit(git.repositoryRoot, ['write-tree']).trim() !== transformation.tree)
  ) {
    throw archiveError(
      'ARCHIVE_ELIGIBILITY_CHANGED',
      'Real repository state changed before archive authorization completed.',
    );
  }
}

function assertArchiveCommit(
  repositoryRoot: string,
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  commitHash: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  if (
    JSON.stringify(facts.parents) !== JSON.stringify([eligibility.head]) ||
    facts.tree !== transformation.tree ||
    facts.message !== `${archiveCommitMessage(eligibility.changeId)}\n` ||
    JSON.stringify(commitChangedPaths(repositoryRoot, commitHash)) !==
      JSON.stringify(transformation.changedPaths)
  ) {
    throw archiveError(
      'ARCHIVE_COMMIT_INVALID',
      'Archive commit object does not match the verified transformation.',
    );
  }
}

function rollbackPatch(
  eligibility: ArchiveEligibility,
  patchPath: string,
): void {
  try {
    runGit(eligibility.repositoryRoot, [
      'apply',
      '-R',
      '--binary',
      '--index',
      patchPath,
    ]);
    const git = discoverRepository(eligibility.repositoryRoot);
    if (
      listChangedPaths(git.repositoryRoot, eligibility.head).length > 0 ||
      listStagedPaths(git.repositoryRoot, eligibility.head).length > 0
    ) {
      throw new Error('rollback state mismatch');
    }
  } catch {
    throw archiveError(
      'ARCHIVE_ROLLBACK_FAILED',
      'Archive patch could not be rolled back safely.',
    );
  }
}

function findExistingArchive(
  cwd: string,
  changeId: string,
): ArchiveTransitionResult | undefined {
  const git = discoverRepository(cwd);
  if (git.statusEntries.length > 0) {
    throw archiveError(
      'ARCHIVE_WORKTREE_DIRTY',
      'Archive idempotency requires a clean repository.',
    );
  }
  const reports = listArchiveReports(
    archiveReportsDirectory(git.repositoryRoot),
    changeId,
  ).filter(
    ({ report }) =>
      report.commitHash === git.head ||
      isAncestor(git.repositoryRoot, report.commitHash, git.head),
  );
  const archiveRoot = path.join(git.repositoryRoot, 'openspec/changes/archive');
  const paths = fs
    .lstatSync(archiveRoot, { throwIfNoEntry: false })
    ?.isDirectory()
    ? fs
        .readdirSync(archiveRoot)
        .filter((entry) =>
          new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(changeId)}$`).test(
            entry,
          ),
        )
    : [];
  const active = fs.existsSync(
    path.join(git.repositoryRoot, 'openspec/changes', changeId),
  );
  if (paths.length === 0 && reports.length === 0) return undefined;
  if (active || paths.length !== 1 || reports.length !== 1) {
    throw archiveError(
      'ARCHIVE_IDEMPOTENCY_INVALID',
      'Archive identity is ambiguous or conflicts with an active change.',
    );
  }
  const [{ reportId, report: recordedReport }] = reports;
  let report: ArchiveTransitionReport;
  try {
    report = readVerifiedArchiveTransitionEvidence(git.repositoryRoot, {
      changeId,
      parentCommit: recordedReport.parent,
      commitHash: recordedReport.commitHash,
      reportId,
    }).report;
  } catch {
    throw archiveError(
      'ARCHIVE_IDEMPOTENCY_INVALID',
      'Archived path does not match its verified evidence.',
    );
  }
  if (report.archivePath !== `openspec/changes/archive/${paths[0]}`) {
    throw archiveError(
      'ARCHIVE_IDEMPOTENCY_INVALID',
      'Archived path does not match its verified evidence.',
    );
  }
  assertLocalArchivePublished(git.repositoryRoot, report);
  return resultFromReport('already-archived', reportId, report);
}

function assertLocalArchivePublished(
  repositoryRoot: string,
  report: ArchiveTransitionReport,
): void {
  if (report.localProtectedBase === undefined) return;
  const protectedCommit = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${report.localProtectedBase.ref}^{commit}`],
    true,
  ).trim();
  if (!isAncestor(repositoryRoot, report.commitHash, protectedCommit)) {
    throw archiveError(
      'ARCHIVE_LOCAL_PROTECTED_BASE_CHANGED',
      'The local protected base no longer contains the archived commit.',
    );
  }
}

function assertReportCurrent(
  directory: string,
  reportId: string,
  report: ArchiveTransitionReport,
): void {
  if (
    JSON.stringify(readArchiveReport(directory, reportId)) !==
    JSON.stringify(report)
  ) {
    throw archiveError('ARCHIVE_REPORT_STALE', 'Archive evidence changed.');
  }
}

function writePatchOnce(filePath: string, patch: string): void {
  try {
    fs.writeFileSync(filePath, patch, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      fs.realpathSync(filePath) !== filePath ||
      fs.readFileSync(filePath, 'utf8') !== patch
    ) {
      throw archiveError(
        'ARCHIVE_PATCH_STORE_INVALID',
        'Archive patch store is unsafe.',
      );
    }
  }
}

function logicalIdentity(
  eligibility: ArchiveEligibility,
  transformation: ArchiveTransformation,
  promotedSpecDigests: Record<string, string>,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        changeId: eligibility.changeId,
        archiveSuffix: eligibility.changeId,
        archivedArtifacts: transformation.archivedArtifactDigests,
        promotedSpecDigests,
      }),
    )
    .digest('hex');
}

function resultFromReport(
  status: ArchiveTransitionResult['status'],
  reportId: string,
  report: ArchiveTransitionReport,
): ArchiveTransitionResult {
  return {
    status,
    changeId: report.changeId,
    archivePath: report.archivePath,
    commitHash: report.commitHash,
    reportId,
    changedPaths: report.changedPaths,
  };
}

function archiveReportsDirectory(repositoryRoot: string): string {
  const git = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return path.join(
    runtimePaths(git.gitCommonDirectory, config.runtimeDirectory).root,
    'archive-reports',
  );
}

function isAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  return (
    runGit(
      repositoryRoot,
      ['merge-base', ancestor, descendant],
      true,
    ).trim() === ancestor
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function archiveError(code: string, message: string) {
  return workflowError(code, message, ExitCode.staleState);
}
