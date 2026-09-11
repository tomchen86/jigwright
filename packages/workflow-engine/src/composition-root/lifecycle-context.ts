/**
 * Assembles repository-backed session context and document disposition services.
 *
 * Invariants:
 * - Session operations retain their runtime identity checks and session lock.
 * - Document services use validated snapshots, canonical delta checks and completed Grant records.
 */
import path from 'node:path';

import { loadWorkflowConfig } from '../runtime/repository-observation/workflow-configuration.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { listStagedPaths } from '../runtime/repository-transaction/git-transitions.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  listChangedPaths,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../runtime/session-workspace/paths.ts';
import {
  assertInvestigationId,
  assertSessionId,
} from '../foundation/repository-path/repository-path.ts';
import type { WorkflowReport } from '../runtime/storage-journal/report-store.ts';
import {
  reportString,
  reportStringArray,
  staleReport,
} from '../runtime/storage-journal/report-validation.ts';
import {
  readSessionFile,
  runtimePaths,
  withSessionOperation,
} from '../runtime/session-workspace/session-store.ts';
import type { SessionInspection } from '../modules/lifecycle/session-inspection.ts';
import {
  createPlanningProviderAuthoringPort,
  planningProviderReviewedAssetMirrors,
} from './planning-provider-authoring-production.ts';

import { createSystemDocumentDispositionService } from '../application/finalize/system-document-dispositions.ts';
import { observeSystemDocumentCandidate } from '../application/finalize/system-document-candidate.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import {
  combineOpenSpecDeltas,
  specDeltaChangesContract,
} from '../runtime/repository-transaction/archive-delta-verifier.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/storage-journal/grant-store.ts';
import {
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
} from '../runtime/storage-journal/system-document-review-store.ts';

export function loadActiveSessionContext(
  cwd: string,
  requestedSessionId: string,
) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  const session = readSessionFile(
    path.join(runtime.sessions, `${sessionId}.json`),
  );
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  return { git, config, runtime, session };
}

export function loadInvestigationRuntimeContext(cwd: string) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  return {
    git,
    config,
    runtime: investigationRuntimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
    lifecycleRuntime: runtimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    ),
    planningProviderAuthoring: () =>
      createPlanningProviderAuthoringPort(git.repositoryRoot),
    planningProviderReviewedAssetMirrors: () =>
      planningProviderReviewedAssetMirrors(git.repositoryRoot),
  };
}

export function assertInvestigationSubjectId(value: string): string {
  return assertInvestigationId(value);
}

export function runSessionOperation<T>(
  cwd: string,
  requestedSessionId: string,
  operation: () => T,
): T {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withSessionOperation(
    runtime,
    assertSessionId(requestedSessionId),
    operation,
  );
}

export function assertFinishProjection(
  report: WorkflowReport,
  inspection: SessionInspection,
): void {
  const stagedPaths = reportStringArray(
    report,
    'stagedPaths',
    'FINISH_REPORT_STALE',
  );
  const currentStaged = listStagedPaths(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  const tree = runGit(inspection.git.repositoryRoot, ['write-tree']).trim();
  if (
    JSON.stringify(stagedPaths) !== JSON.stringify(currentStaged) ||
    JSON.stringify(stagedPaths) !== JSON.stringify(inspection.changedPaths) ||
    reportString(report, 'tree', 'FINISH_REPORT_STALE') !== tree
  ) {
    throw staleReport('FINISH_REPORT_STALE');
  }
}

export const systemDocumentDispositions =
  createSystemDocumentDispositionService({
    observeSystemDocumentCandidate: (cwd, sessionId) =>
      observeSystemDocumentCandidate(cwd, sessionId, {
        loadActiveSessionContext,
        readSystemDescriptionSnapshot,
        listChangedPaths,
        fingerprintRepositoryProjection,
        deltaChangesContract: (documentPath, before, deltas) =>
          specDeltaChangesContract(
            documentPath,
            before,
            combineOpenSpecDeltas(deltas),
          ),
      }),
    runSessionOperation,
    readSystemDocumentReviewRecord,
    writeSystemDocumentReviewRecord,
    readCompletedGrant(runtimeRoot, challengeId) {
      const record = createFileGrantRecordStore(
        grantStorePaths(runtimeRoot),
      ).readGrantRecord(challengeId);
      return record.state === 'completed' ? record : null;
    },
  });
