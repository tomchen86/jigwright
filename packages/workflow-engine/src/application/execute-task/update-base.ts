import fs from 'node:fs';
import path from 'node:path';

import {
  loadCommittedChangeContract,
  loadWorkflowConfig,
  repositoryHandoffPath,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import {
  renderHandoff,
  validateHandoff,
} from '../../adapters/consumer/repository/handoff/handoff.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';
import { verifyPullRequest } from '../../entrypoints/ci/ci.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { createTaskPlanningAssuranceBinding } from '../../modules/assurance/planning-assurance-validator.ts';
import { replaceTextAtomic } from '../../runtime/repository-transaction/atomic-text.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { assertChangeId } from '../../runtime/session-workspace/paths.ts';
import {
  readSessionFile,
  runtimePaths,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  writeJsonAtomic,
  type WorkflowSession,
} from '../../runtime/session-workspace/session-store.ts';
import { listSessions } from './session.ts';

export type TaskBaseUpdateResult = Readonly<{
  schemaVersion: 1;
  kind: 'task-session-base-update';
  changeId: string;
  sessionId: string;
  branch: string;
  ontoRef: string;
  ontoCommit: string;
  oldHead: string;
  newHead: string;
  revalidated: Readonly<{
    applicabilityNodeId: string;
    planningGenerationId: string;
    reviewNodeId: string;
    allowedPaths: readonly string[];
  }>;
  assurance: Readonly<{
    base: string;
    head: string;
    checkIds: readonly string[];
  }>;
}>;

type TaskBaseRefreshReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'task-session-base-refresh-receipt.v1';
  changeId: string;
  sessionId: string;
  branch: string;
  ontoRef: string;
  ontoCommit: string;
  oldHead: string;
  newHead: string;
  invalidatedRuntimeReportIds: readonly string[];
  assuranceCheckIds: readonly string[];
  planningGenerationId: string;
  completedAt: string;
}>;

type GeneratedProjectionSnapshot = Readonly<{
  filePath: string;
  content: string | null;
}>;

/**
 * Replay one finished managed task branch onto a locally available base and
 * recompute current planning, generated-document, check, and local PR
 * assurance. The command never fetches, stashes, resolves a conflict, or
 * operates while a task writer is active.
 */
export function updateTaskSessionBase(
  cwd: string,
  requestedChangeId: string,
  requestedOntoRef: string,
  environment: NodeJS.ProcessEnv = process.env,
): TaskBaseUpdateResult {
  const changeId = assertChangeId(requestedChangeId);
  const ontoRef = requestedOntoRef.trim();
  if (ontoRef.length === 0 || ontoRef.startsWith('-')) {
    throw workflowError(
      'UPDATE_BASE_REF_INVALID',
      'update-base requires a non-option Git ref after --onto.',
      ExitCode.usage,
    );
  }
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessions = listSessions(cwd);
  const active = sessions.filter(
    (session) =>
      session.changeId === changeId &&
      (session.state === 'active' || session.state === 'revising'),
  );
  if (active.length > 0) {
    throw workflowError(
      'UPDATE_BASE_ACTIVE_SESSION_PRESENT',
      `Change ${changeId} must finish its active task session before update-base.`,
      ExitCode.verification,
      {
        details: { activeSessionIds: active.map(({ sessionId }) => sessionId) },
      },
    );
  }
  const anchor = resolveFinishedSessionAnchor(
    runtime,
    sessions,
    discovered,
    changeId,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withSessionOperation(runtime, anchor.sessionId, () => {
      assertRepositoryLock();
      return updateFinishedTaskBaseLocked(
        cwd,
        anchor,
        ontoRef,
        environment,
        assertRepositoryLock,
      );
    }),
  );
}

function resolveFinishedSessionAnchor(
  runtime: ReturnType<typeof runtimePaths>,
  sessions: readonly WorkflowSession[],
  discovered: ReturnType<typeof discoverRepository>,
  changeId: string,
): WorkflowSession {
  const priorReceipt = readBaseRefreshReceipt(
    runtime,
    changeId,
    discovered.head,
  );
  if (priorReceipt !== null && priorReceipt.branch !== discovered.branch) {
    throw baseRefreshReceiptInvalid(changeId, discovered.head);
  }
  const candidates = sessions.filter(
    (session) =>
      session.state === 'committed' &&
      session.changeId === changeId &&
      session.repositoryRoot === discovered.repositoryRealPath &&
      session.branch === discovered.branch &&
      (priorReceipt === null
        ? session.commitHash === discovered.head
        : session.sessionId === priorReceipt.sessionId),
  );
  if (candidates.length !== 1) {
    throw workflowError(
      'UPDATE_BASE_FINISHED_SESSION_REQUIRED',
      `Change ${changeId} requires one exact finished managed task at the current branch head.`,
      ExitCode.staleState,
      {
        details: {
          currentHead: discovered.head,
          candidateSessionIds: candidates.map(({ sessionId }) => sessionId),
        },
      },
    );
  }
  return candidates[0]!;
}

function updateFinishedTaskBaseLocked(
  cwd: string,
  session: WorkflowSession,
  ontoRef: string,
  environment: NodeJS.ProcessEnv,
  assertRepositoryLock: () => void,
): TaskBaseUpdateResult {
  const before = discoverRepository(cwd);
  assertRepositoryLock();
  if (
    before.statusEntries.length !== 0 ||
    before.branch !== session.branch ||
    before.repositoryRealPath !== session.repositoryRoot
  ) {
    throw workflowError(
      'UPDATE_BASE_WORKTREE_NOT_READY',
      'update-base requires the exact clean finished task worktree and branch.',
      ExitCode.guard,
      {
        details: {
          entryCount: before.statusEntries.length,
          branch: before.branch,
        },
      },
    );
  }
  const runtime = runtimePaths(
    before.gitCommonDirectory,
    loadWorkflowConfig(before.repositoryRoot).runtimeDirectory,
  );
  const persisted = readSessionFile(
    path.join(runtime.sessions, `${session.sessionId}.json`),
  );
  if (JSON.stringify(persisted) !== JSON.stringify(session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The finished session changed during update-base.',
      ExitCode.staleState,
    );
  }

  const oldHead = before.head;
  const generatedProjection = captureGeneratedProjection(before.repositoryRoot);
  loadCommittedChangeContract(before.repositoryRoot, oldHead, session.changeId);
  const ontoCommit = resolveOntoCommit(cwd, ontoRef);
  const mergeBase = runGit(
    cwd,
    ['merge-base', oldHead, ontoCommit],
    true,
  ).trim();
  if (!isObjectId(mergeBase)) {
    throw workflowError(
      'UPDATE_BASE_HISTORY_UNRELATED',
      'The selected base does not share a verifiable commit ancestor with the task branch.',
      ExitCode.guard,
      { details: { ontoRef, ontoCommit } },
    );
  }
  if (mergeBase === ontoCommit) {
    throw workflowError(
      'UPDATE_BASE_NOT_ADVANCED',
      'The selected base does not advance this task branch.',
      ExitCode.staleState,
      { details: { ontoRef, ontoCommit, mergeBase } },
    );
  }

  replayOnto(cwd, session.branch, ontoCommit, mergeBase);
  try {
    assertRepositoryLock();
    const afterReplay = discoverRepository(cwd);
    const validated = loadStableValidatedChangeContract(
      afterReplay,
      session.changeId,
    );
    const policy = validated.contract.guard.tasks[session.taskId];
    const planningAssurance = createTaskPlanningAssuranceBinding(
      validated.contract,
      validated.contract.planningAssurance,
    );
    const allowedPathsCurrent =
      policy !== undefined &&
      JSON.stringify(policy.allowedPaths) ===
        JSON.stringify(session.allowedPaths);
    const requiredChecksCurrent =
      policy !== undefined &&
      JSON.stringify(policy.requiredChecks) ===
        JSON.stringify(session.requiredChecks);
    const planningAssuranceCurrent =
      JSON.stringify(planningAssurance) ===
      JSON.stringify(session.planningAssurance ?? null);
    const changedAuthorityPaths = listChangedChangeAuthorityPaths(
      cwd,
      oldHead,
      afterReplay.head,
      session.changeId,
    );
    const finishedAuthorityCurrent = changedAuthorityPaths.length === 0;
    if (
      planningAssurance === null ||
      policy === undefined ||
      !allowedPathsCurrent ||
      !requiredChecksCurrent ||
      !planningAssuranceCurrent ||
      !finishedAuthorityCurrent
    ) {
      throw workflowError(
        'UPDATE_BASE_AUTHORITY_CHANGED',
        'The refreshed base changed the current v3 Manifest, PlanReview, task scope, or planning artifacts.',
        ExitCode.staleState,
        {
          details: {
            planningAssurancePresent: planningAssurance !== null,
            taskPolicyPresent: policy !== undefined,
            allowedPathsCurrent,
            requiredChecksCurrent,
            planningAssuranceCurrent,
            finishedAuthorityCurrent,
            changedAuthorityPaths,
          },
        },
      );
    }

    // Regeneration is semantic and idempotent. A changed projection requires
    // its own reviewed managed transition; update-base never text-merges or
    // silently amends a generated document.
    renderHandoff(cwd);
    const afterProjection = discoverRepository(cwd);
    if (afterProjection.statusEntries.length !== 0) {
      throw workflowError(
        'UPDATE_BASE_GENERATED_RECONCILIATION_REQUIRED',
        'The refreshed base changes a generated lifecycle projection.',
        ExitCode.staleState,
        {
          details: {
            changedPaths: [...afterProjection.statusEntries],
          },
          recovery:
            'Apply the generated projection through its reviewed managed transition, then retry update-base.',
        },
      );
    }
    validateHandoff(cwd);
    const assurance = verifyPullRequest(
      cwd,
      ontoCommit,
      afterReplay.head,
      environment,
    );
    assertRepositoryLock();
    const checkIds = [
      ...new Set(assurance.checks.map(({ checkId }) => checkId)),
    ].sort();
    const receipt: TaskBaseRefreshReceipt = {
      schemaVersion: 1,
      kind: 'task-session-base-refresh-receipt.v1',
      changeId: session.changeId,
      sessionId: session.sessionId,
      branch: session.branch,
      ontoRef,
      ontoCommit,
      oldHead,
      newHead: afterReplay.head,
      invalidatedRuntimeReportIds: sessionRuntimeReportIds(session),
      assuranceCheckIds: checkIds,
      planningGenerationId: planningAssurance.planningGenerationId,
      completedAt: new Date().toISOString(),
    };
    writeJsonAtomic(
      baseRefreshReceiptPath(
        runtimePaths(
          afterReplay.gitCommonDirectory,
          validated.contract.config.runtimeDirectory,
        ),
        session.changeId,
        afterReplay.head,
      ),
      receipt,
    );
    return {
      schemaVersion: 1,
      kind: 'task-session-base-update',
      changeId: session.changeId,
      sessionId: session.sessionId,
      branch: session.branch,
      ontoRef,
      ontoCommit,
      oldHead,
      newHead: afterReplay.head,
      revalidated: {
        applicabilityNodeId: planningAssurance.applicabilityNodeId,
        planningGenerationId: planningAssurance.planningGenerationId,
        reviewNodeId: planningAssurance.reviewNodeId,
        allowedPaths: [...policy.allowedPaths],
      },
      assurance: {
        base: assurance.base,
        head: assurance.head,
        checkIds,
      },
    };
  } catch (error) {
    restoreOriginalBranch(cwd, session.branch, oldHead);
    restoreGeneratedProjection(generatedProjection);
    throw error;
  }
}

function resolveOntoCommit(cwd: string, ontoRef: string): string {
  const resolved = runGit(
    cwd,
    ['rev-parse', '--verify', '--end-of-options', `${ontoRef}^{commit}`],
    true,
  ).trim();
  if (!isObjectId(resolved)) {
    throw workflowError(
      'UPDATE_BASE_REF_INVALID',
      `Unable to resolve ${ontoRef} to a local commit.`,
      ExitCode.usage,
      {
        details: { ontoRef },
        recovery: 'Fetch or otherwise materialize the intended ref separately.',
      },
    );
  }
  return resolved;
}

function replayOnto(
  cwd: string,
  branch: string,
  ontoCommit: string,
  mergeBase: string,
): void {
  try {
    runGit(cwd, ['rebase', '--onto', ontoCommit, mergeBase, branch]);
  } catch (error) {
    runGit(cwd, ['rebase', '--abort'], true);
    throw workflowError(
      'UPDATE_BASE_REPLAY_FAILED',
      'The task branch could not be replayed cleanly onto the selected base.',
      ExitCode.conflict,
      {
        details: {
          branch,
          ontoCommit,
          cause: error instanceof Error ? error.message : String(error),
        },
        recovery:
          'Resolve the base relationship outside an active task session.',
      },
    );
  }
}

function restoreOriginalBranch(
  cwd: string,
  branch: string,
  oldHead: string,
): void {
  const current = discoverRepository(cwd);
  if (current.head !== oldHead) {
    runGit(cwd, ['update-ref', `refs/heads/${branch}`, oldHead, current.head]);
    runGit(cwd, [
      'restore',
      `--source=${oldHead}`,
      '--staged',
      '--worktree',
      '--',
      ':/',
    ]);
  }
}

function captureGeneratedProjection(
  repositoryRoot: string,
): GeneratedProjectionSnapshot {
  const filePath = repositoryHandoffPath(repositoryRoot);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return { filePath, content: null };
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw workflowError(
      'UPDATE_BASE_GENERATED_PROJECTION_UNSAFE',
      'The generated handoff is not a safe regular file.',
      ExitCode.unsafeEnvironment,
    );
  }
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
}

function restoreGeneratedProjection(
  snapshot: GeneratedProjectionSnapshot,
): void {
  if (snapshot.content !== null) {
    replaceTextAtomic(snapshot.filePath, snapshot.content);
    return;
  }
  const stats = fs.lstatSync(snapshot.filePath, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw workflowError(
      'UPDATE_BASE_ROLLBACK_FAILED',
      'The generated handoff changed to an unsafe filesystem object during rollback.',
      ExitCode.unsafeEnvironment,
    );
  }
  fs.unlinkSync(snapshot.filePath);
}

function readBaseRefreshReceipt(
  runtime: ReturnType<typeof runtimePaths>,
  changeId: string,
  currentHead: string,
): TaskBaseRefreshReceipt | null {
  const receiptPath = baseRefreshReceiptPath(runtime, changeId, currentHead);
  const stats = fs.lstatSync(receiptPath, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw baseRefreshReceiptInvalid(changeId, currentHead);
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    throw baseRefreshReceiptInvalid(changeId, currentHead);
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'assuranceCheckIds',
        'branch',
        'changeId',
        'completedAt',
        'invalidatedRuntimeReportIds',
        'kind',
        'newHead',
        'oldHead',
        'ontoCommit',
        'ontoRef',
        'planningGenerationId',
        'schemaVersion',
        'sessionId',
      ]
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-session-base-refresh-receipt.v1' ||
    value.changeId !== changeId ||
    typeof value.sessionId !== 'string' ||
    !/^session-\d{17}-[0-9a-f-]{36}$/.test(value.sessionId) ||
    typeof value.branch !== 'string' ||
    value.branch.length === 0 ||
    typeof value.ontoRef !== 'string' ||
    value.ontoRef.length === 0 ||
    !isObjectId(value.ontoCommit) ||
    !isObjectId(value.oldHead) ||
    value.newHead !== currentHead ||
    !Array.isArray(value.invalidatedRuntimeReportIds) ||
    !value.invalidatedRuntimeReportIds.every(isObjectId) ||
    !Array.isArray(value.assuranceCheckIds) ||
    !value.assuranceCheckIds.every(
      (checkId): checkId is string =>
        typeof checkId === 'string' && checkId.length > 0,
    ) ||
    typeof value.planningGenerationId !== 'string' ||
    !isObjectId(value.planningGenerationId) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    throw baseRefreshReceiptInvalid(changeId, currentHead);
  }
  return value as TaskBaseRefreshReceipt;
}

function baseRefreshReceiptPath(
  runtime: ReturnType<typeof runtimePaths>,
  changeId: string,
  head: string,
): string {
  return path.join(runtime.root, 'base-refreshes', changeId, `${head}.json`);
}

function sessionRuntimeReportIds(session: WorkflowSession): string[] {
  return [
    session.latestCheckReportId,
    session.completionReportId,
    session.finishReportId,
    session.commitReportId,
    session.implementationReconciliationReportId,
  ]
    .filter((reportId): reportId is string => reportId !== undefined)
    .sort();
}

function baseRefreshReceiptInvalid(
  changeId: string,
  currentHead: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'UPDATE_BASE_RECEIPT_INVALID',
    `The update-base receipt for ${changeId} at ${currentHead} is invalid.`,
    ExitCode.guard,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listChangedChangeAuthorityPaths(
  cwd: string,
  oldHead: string,
  newHead: string,
  changeId: string,
): string[] {
  return runGit(cwd, [
    'diff',
    '--name-only',
    oldHead,
    newHead,
    '--',
    `openspec/changes/${changeId}`,
  ])
    .split('\n')
    .filter((artifactPath) => artifactPath.length > 0)
    .sort();
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
}
