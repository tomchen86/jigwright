/** Restores an authorized completion projection and durably resets its session, preserving compensation order. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  assertCompletionRollbackSession,
  assertCompletionRollbackRepository,
  assertCompletionRollbackReport,
  assertCompletionRollbackDocumentPaths,
  resetCompletionRollbackSession,
  type RollbackCompletionResult,
} from '../../../modules/lifecycle/completion-rollback.ts';
import type { WorkflowSession } from '../../../modules/lifecycle/workflow-session-contract.ts';
import type {
  ManagedDocumentOperations,
  GeneratedDocumentMutation,
} from '../../../modules/projection/managed-documents.ts';
import { classifyProjectionPaths } from '../../../modules/projection/engine-projection-registry.ts';
import type { readWorkflowSessionContext } from '../../repository-observation/workflow-session-context.ts';
import {
  discoverRepository,
  readFileAtCommit,
} from '../../repository-transaction/git.ts';
import { listStagedPaths } from '../../repository-transaction/git-transitions.ts';
import {
  assertOwnedLock,
  readSessionFile,
  writeJsonAtomic,
} from '../../session-workspace/session-store.ts';
import { readImmutableReport } from '../../storage-journal/report-store.ts';
import {
  assertProjectionPathClassification,
  reportString,
  reportStringArray,
  reportTaskIds,
  staleReport,
} from '../../storage-journal/report-validation.ts';
import {
  completionDocumentPaths,
  rollbackGeneratedDocuments,
} from '../validation/managed-documents.ts';
import {
  assertExactTaskProjection,
  digestTaskContent,
  restoreTaskProjection,
} from './task-projection.ts';

export function rollbackCompletionProjection(
  context: ReturnType<typeof readWorkflowSessionContext>,
  reason: string,
  managedDocuments: Pick<ManagedDocumentOperations, 'validateManagedDocuments'>,
): RollbackCompletionResult {
  const { git, runtime, session } = context;
  assertCompletionRollbackSession(session);
  assertPinnedRollbackState(context);

  const completionReport = readImmutableReport(
    runtime.reports,
    session.sessionId,
    session.completionReportId,
  );
  assertCompletionRollbackReport(completionReport, session);
  const completedTaskIds = reportTaskIds(
    completionReport,
    'COMPLETION_REPORT_STALE',
  );
  const transitionPaths = reportStringArray(
    completionReport,
    'transitionPaths',
    'COMPLETION_REPORT_STALE',
  );
  const configuredTransitionPaths = completionDocumentPaths(git.repositoryRoot);
  assertCompletionRollbackDocumentPaths(
    transitionPaths,
    configuredTransitionPaths,
  );

  const tasksPathRelative = `${context.config.changeRoot}/${session.changeId}/tasks.md`;
  assertProjectionPathClassification(
    completionReport,
    classifyProjectionPaths(
      reportStringArray(
        completionReport,
        'changedPaths',
        'COMPLETION_REPORT_STALE',
      ),
      [tasksPathRelative],
      transitionPaths,
    ),
    'COMPLETION_REPORT_STALE',
  );
  const tasksPath = path.join(git.repositoryRoot, tasksPathRelative);
  const baselineTasks = readFileAtCommit(
    git.repositoryRoot,
    session.baseline.head,
    tasksPathRelative,
  );
  if (baselineTasks === undefined) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
  const projectedTasks = fs.readFileSync(tasksPath, 'utf8');
  assertExactTaskProjection(baselineTasks, projectedTasks, completedTaskIds);
  if (
    reportString(
      completionReport,
      'projectionSourceDigest',
      'COMPLETION_REPORT_STALE',
    ) !== digestTaskContent(baselineTasks)
  ) {
    throw staleReport('COMPLETION_REPORT_STALE');
  }
  managedDocuments.validateManagedDocuments(git.repositoryRoot);

  const documentMutations = transitionPaths.map((documentPath) => {
    const absolutePath = path.join(git.repositoryRoot, documentPath);
    return {
      path: documentPath,
      before: readFileAtCommit(
        git.repositoryRoot,
        session.baseline.head,
        documentPath,
      ),
      after: fs.readFileSync(absolutePath, 'utf8'),
    } satisfies GeneratedDocumentMutation;
  });
  const restoredPaths = [...transitionPaths, tasksPathRelative].sort();
  const rolledBackAt = new Date().toISOString();
  const completionReportId = session.completionReportId;
  const resetSession: WorkflowSession = resetCompletionRollbackSession(session);
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  let rollbackRecordPath: string | undefined;

  try {
    restoreTaskProjection(tasksPath, projectedTasks, baselineTasks);
    rollbackGeneratedDocuments(git.repositoryRoot, documentMutations);
    assertPinnedRollbackState(context);
    if (
      JSON.stringify(readSessionFile(sessionPath)) !== JSON.stringify(session)
    ) {
      throw workflowError(
        'SESSION_CHANGED_DURING_TRANSITION',
        'The session changed before its completion rollback could be persisted.',
        ExitCode.staleState,
      );
    }

    const record = {
      schemaVersion: 1,
      kind: 'completion-rollback',
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: session.taskId,
      completionReportId,
      rolledBackAt,
      reason,
      restoredPaths,
    } as const;
    const recordContent = `${JSON.stringify(record, null, 2)}\n`;
    const rollbackRecordId = crypto
      .createHash('sha256')
      .update(recordContent)
      .digest('hex');
    const rollbackDirectory = path.join(
      runtime.root,
      'completion-rollbacks',
      session.sessionId,
    );
    fs.mkdirSync(rollbackDirectory, { recursive: true });
    assertPlainDirectory(runtime.root);
    assertPlainDirectory(path.join(runtime.root, 'completion-rollbacks'));
    assertPlainDirectory(rollbackDirectory);
    rollbackRecordPath = path.join(
      rollbackDirectory,
      `${rollbackRecordId}.json`,
    );
    writeJsonAtomic(rollbackRecordPath, record);
    writeJsonAtomic(sessionPath, resetSession);

    return {
      session: resetSession,
      completionReportId,
      rollbackRecordId,
      restoredPaths,
      rolledBackAt,
      reason,
    };
  } catch (error) {
    if (rollbackRecordPath) {
      fs.rmSync(rollbackRecordPath, { force: true });
    }
    writePlainFile(tasksPath, projectedTasks);
    for (const mutation of documentMutations) {
      writePlainFile(
        path.join(git.repositoryRoot, mutation.path),
        mutation.after,
      );
    }
    throw error;
  }
}

function assertPinnedRollbackState(
  context: ReturnType<typeof readWorkflowSessionContext>,
): void {
  const { git, runtime, session } = context;
  const current = discoverRepository(git.repositoryRoot);
  assertCompletionRollbackRepository(current, session);
  assertOwnedLock(
    path.join(runtime.locks, `${session.changeId}.lock`),
    session.sessionId,
    session.changeId,
    session.taskId,
  );
  if (listStagedPaths(git.repositoryRoot, session.baseline.head).length > 0) {
    throw workflowError(
      'ROLLBACK_INDEX_NOT_EMPTY',
      'Completion rollback requires an empty index.',
      ExitCode.staleState,
    );
  }
}

function assertPlainDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw workflowError(
      'ROLLBACK_RECORD_DIRECTORY_UNSAFE',
      'Completion rollback record directory is missing or unsafe.',
      ExitCode.staleState,
    );
  }
}

function writePlainFile(filePath: string, content: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw workflowError(
      'ROLLBACK_PATH_UNSAFE',
      'Completion rollback encountered an unsafe projected file.',
      ExitCode.staleState,
    );
  }
  fs.writeFileSync(filePath, content, 'utf8');
}
