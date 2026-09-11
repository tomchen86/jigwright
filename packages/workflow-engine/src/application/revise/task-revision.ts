/**
 * Revises and resumes task planning while preserving implementation and
 * session authority.
 *
 * Invariants:
 * - Planning operations require the exact live revision lease and revising
 *   session.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import {
  isPlanningAssuranceBinding,
  loadChangeContract,
  loadWorkflowConfig,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  listChangedPaths,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  commitChangedPaths,
  commitFacts,
  stageExactPathsPreservingUnstaged,
  updateManagedRef,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  refreshPlanningDocuments,
  rollbackGeneratedDocuments,
} from '../../runtime/managed-documents/validation/managed-documents.ts';
import {
  assertSessionId,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../../runtime/session-workspace/paths.ts';
import { createTaskPlanningAssuranceBinding } from '../../modules/assurance/planning-assurance-validator.ts';
import { readPlanningTransitionReport } from '../../runtime/storage-journal/planning-report.ts';
import { commitTaskRevisionPlanningTransitionUnderAuthority } from '../propose/planning-transition.ts';
import {
  withTaskRevisionPlanningAuthority,
  type HeldChangeTransitionAuthority,
} from '../../runtime/session-workspace/planning-lock.ts';
import {
  assertOwnedLock,
  readSessionFile,
  runtimePaths,
  type WorkflowSession,
  withRepositoryLifecycleOperation,
  withSessionOperation,
  writeJsonAtomic,
} from '../../runtime/session-workspace/session-store.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';
import { inspectSession } from '../finalize/verification.ts';
import {
  readAndValidateTaskRevisionApproval,
  taskRevisionApprovalTargetDigest,
  type TaskRevisionApprovalBinding,
  type TaskRevisionApprovalValidationOptions,
} from '../../modules/authority/task-revision-approval.ts';

import { createTaskRevisionImplementationSnapshot } from './task-revision-implementation-snapshot.ts';
import { createTaskRevisionJournalStore } from './task-revision-journal.ts';
export type { ImplementationSnapshotEntry } from './task-revision-implementation-snapshot.ts';
import type {
  TaskRevisionPhase,
  StagingGeneratedMutation,
  TaskRevisionJournal,
} from './task-revision-journal.ts';
export type {
  TaskRevisionPhase,
  TaskRevisionJournal,
} from './task-revision-journal.ts';

// Production observations stay anchored at the existing lifecycle boundary.
const runtime = {
  normalizeChangedPath,
  runtimePaths,
  ensurePlainDirectory,
  writeJsonAtomic,
  isPlanningAssuranceBinding,
};
export type TaskRevisionRuntimeBindings = typeof runtime;
export type TaskRevisionRuntimeData = { WorkflowSession: WorkflowSession };
const implementationSnapshot =
  createTaskRevisionImplementationSnapshot(runtime);
const {
  snapshotImplementationPaths,
  digestImplementationSnapshot,
  digestValue,
  revisionDrift,
} = implementationSnapshot;
const journal = createTaskRevisionJournalStore(runtime, implementationSnapshot);
const {
  createRevisionJournal,
  transitionJournal,
  readRevisionJournal,
  findLiveRevisionJournal,
  findLatestRevisionJournal,
  corruptRevisionState,
} = journal;

const REVISION_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

export type TaskRevisionResult = Readonly<{
  session: WorkflowSession;
  lease: TaskRevisionJournal;
}>;

export type TaskRevisionStatus = Readonly<{
  leaseId: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  phase: TaskRevisionPhase;
  reason: string;
  createdAt: string;
  expiresAt: string;
  implementationFingerprint: string;
  implementationPaths: string[];
  planCommitHash: string | null;
  planReportId: string | null;
  planChangedPaths: string[];
  approvalId: string | null;
  retrySafe: boolean;
  retryCommand: string | null;
}>;

export type TaskRevisionOptions = Readonly<{
  now?: () => Date;
  approvalId?: string;
  approvalVerifier?: TaskRevisionApprovalValidationOptions['verifier'];
  /** Test-only deterministic interruption after one durable phase. */
  testCrashAfter?:
    | 'lease-prepared'
    | 'session-revising'
    | 'planning-staging-prepared'
    | 'plan-commit-prepared'
    | 'plan-ref-updated'
    | 'resume-prepared'
    | 'session-active';
}>;

/**
 * Run one bounded planning mutation through the authority already owned by an
 * exact revising task. This is the public bridge used by high-level planning
 * orchestration; it does not create a second change lock or a replacement
 * session.
 */
export function withTaskRevisionPlanningOperation<T>(
  cwd: string,
  requestedSessionId: string,
  operation: (authority: HeldChangeTransitionAuthority) => T,
): T {
  const sessionId = assertSessionId(requestedSessionId);
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withSessionOperation(runtime, sessionId, () => {
      assertRepositoryLock();
      const current = readSessionFile(sessionPath(runtime, sessionId));
      const journal = findLiveRevisionJournal(runtime, sessionId);
      if (
        current.state !== 'revising' ||
        journal === null ||
        journal.phase !== 'revising' ||
        current.revisionLeaseId !== journal.leaseId
      ) {
        throw workflowError(
          'TASK_REVISION_AUTHORITY_STALE',
          'Planning orchestration requires the exact live revising task session.',
          ExitCode.staleState,
        );
      }
      assertResumePathState(
        discovered.repositoryRoot,
        config.changeRoot,
        current,
        journal,
      );
      return withTaskRevisionPlanningAuthority(
        runtime,
        current,
        journal.leaseId,
        assertRepositoryLock,
        operation,
      );
    }),
  );
}

export function reviseTask(
  cwd: string,
  requestedSessionId: string,
  requestedReason: string,
  options: TaskRevisionOptions = {},
): TaskRevisionResult {
  const sessionId = assertSessionId(requestedSessionId);
  const reason = assertRevisionReason(requestedReason);
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withSessionOperation(runtime, sessionId, () => {
      assertRepositoryLock();
      const current = readSessionFile(sessionPath(runtime, sessionId));
      const live = findLiveRevisionJournal(runtime, sessionId);
      if (live !== null) {
        return reconcileReviseTask(
          cwd,
          runtime,
          current,
          live,
          reason,
          options,
          assertRepositoryLock,
        );
      }
      if (current.state !== 'active') {
        throw sessionNotActive(current);
      }
      assertRevisionSessionEligible(current);
      const inspection = inspectSession(cwd, sessionId, {
        expectedSession: current,
      });
      assertRepositoryLock();
      assertOwnedLock(
        path.join(runtime.locks, `${current.changeId}.lock`),
        sessionId,
        current.changeId,
        current.taskId,
      );
      if (
        listStagedPaths(discovered.repositoryRoot, current.baseline.head)
          .length > 0
      ) {
        throw workflowError(
          'REVISION_STAGING_PRESENT',
          'revise-task requires the workflow-owned index to remain clean.',
          ExitCode.staleState,
        );
      }
      assertImplementationPlanningDisjoint(
        inspection.changedPaths,
        config.changeRoot,
        current.changeId,
      );
      const implementationSnapshot = snapshotImplementationPaths(
        discovered.repositoryRoot,
        inspection.changedPaths,
      );
      const now = trustedNow(options.now);
      const journal: TaskRevisionJournal = {
        schemaVersion: 1,
        kind: 'task-revision-lease.v1',
        phase: 'prepared',
        leaseId: `revision-${crypto.randomUUID()}`,
        sessionId,
        changeId: current.changeId,
        taskId: current.taskId,
        reason,
        actorAuthorityId:
          current.mandateBinding?.mandateId ?? current.sessionId,
        repositoryRoot: current.repositoryRoot,
        gitCommonDirectory: current.gitCommonDirectory,
        branch: current.branch,
        head: current.baseline.head,
        tree: current.baseline.tree,
        indexTree: runGit(discovered.repositoryRoot, ['write-tree']).trim(),
        contractDigest: inspection.contract.contractDigest,
        artifactDigests: { ...current.artifacts },
        allowedPaths: [...current.allowedPaths],
        requiredChecks: [...current.requiredChecks],
        requiredCheckDigests: { ...current.requiredCheckDigests },
        planningAssurance: current.planningAssurance ?? null,
        implementationPaths: [...inspection.changedPaths],
        implementationSnapshot,
        implementationFingerprint: digestImplementationSnapshot(
          implementationSnapshot,
        ),
        sessionBeforeDigest: digestValue(current),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + REVISION_LEASE_TTL_MS,
        ).toISOString(),
      };
      createRevisionJournal(runtime, journal);
      crashAfter(options, 'lease-prepared');

      const revisingSession = revisionSession(current, journal.leaseId);
      writeSessionCas(runtime, current, revisingSession);
      const sessionRevising = transitionJournal(runtime, journal, {
        ...journal,
        phase: 'session-revising',
      });
      crashAfter(options, 'session-revising');
      const revising = transitionJournal(runtime, sessionRevising, {
        ...sessionRevising,
        phase: 'revising',
      });
      assertRepositoryLock();
      return { session: revisingSession, lease: revising };
    }),
  );
}

export function resumeTask(
  cwd: string,
  requestedSessionId: string,
  options: TaskRevisionOptions = {},
): TaskRevisionResult {
  const sessionId = assertSessionId(requestedSessionId);
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withSessionOperation(runtime, sessionId, () => {
      assertRepositoryLock();
      const current = readSessionFile(sessionPath(runtime, sessionId));
      const journal = findLiveRevisionJournal(runtime, sessionId);
      if (journal === null) {
        const terminal = findLatestRevisionJournal(runtime, sessionId);
        if (terminal?.phase === 'completed' && current.state === 'active') {
          return { session: current, lease: terminal };
        }
        throw workflowError(
          'REVISION_LEASE_NOT_FOUND',
          `Session ${sessionId} has no live task revision lease.`,
          ExitCode.staleState,
        );
      }
      if (journal.phase === 'abort-prepared') {
        throw workflowError(
          'REVISION_ABORT_IN_PROGRESS',
          'The revision lease is already being terminally aborted.',
          ExitCode.staleState,
        );
      }
      if (journal.phase === 'resume-prepared') {
        return completePreparedResume(
          cwd,
          runtime,
          current,
          journal,
          options,
          assertRepositoryLock,
        );
      }
      if (journal.phase === 'plan-committed') {
        return completeCommittedPlanningRevision(
          runtime,
          current,
          journal,
          options,
          assertRepositoryLock,
        );
      }
      if (journal.phase === 'planning-staging-prepared') {
        return recoverPreparedPlanningStaging(
          cwd,
          runtime,
          current,
          journal,
          options,
          assertRepositoryLock,
        );
      }
      if (journal.phase === 'plan-commit-prepared') {
        return recoverPreparedPlanningRevision(
          runtime,
          current,
          journal,
          options,
          assertRepositoryLock,
        );
      }
      if (
        journal.phase !== 'revising' &&
        journal.phase !== 'session-revising' &&
        journal.phase !== 'prepared'
      ) {
        throw corruptRevisionState();
      }
      if (
        current.state !== 'revising' ||
        current.revisionLeaseId !== journal.leaseId
      ) {
        throw corruptRevisionState();
      }
      assertLeaseCurrent(journal, current, discovered.repositoryRoot);
      const now = trustedNow(options.now);
      if (now.getTime() >= Date.parse(journal.expiresAt)) {
        throw workflowError(
          'REVISION_LEASE_EXPIRED',
          'The task revision lease expired before resume authorization.',
          ExitCode.staleState,
          {
            details: { expiresAt: journal.expiresAt, leaseId: journal.leaseId },
            recovery: `Abort session ${sessionId} or obtain a new task authority after explicit recovery.`,
          },
        );
      }
      const planningPaths = assertResumePathState(
        discovered.repositoryRoot,
        config.changeRoot,
        current,
        journal,
      );
      if (planningPaths.length > 0) {
        return commitPlanningRevision(
          cwd,
          runtime,
          current,
          journal,
          options,
          assertRepositoryLock,
        );
      }
      assertNoOpResumeContract(discovered.repositoryRoot, current, journal);
      const active = activeSessionAfterNoOpRevision(current);
      const prepared = transitionJournal(runtime, journal, {
        ...journal,
        phase: 'resume-prepared',
        resumePreparedAt: now.toISOString(),
        resumeSessionDigest: digestValue(active),
      });
      crashAfter(options, 'resume-prepared');
      writeSessionCas(runtime, current, active);
      crashAfter(options, 'session-active');
      assertRepositoryLock();
      const completed = transitionJournal(runtime, prepared, {
        ...prepared,
        phase: 'completed',
        completedAt: now.toISOString(),
      });
      return { session: active, lease: completed };
    }),
  );
}

export function inspectTaskRevisionStatus(
  cwd: string,
  requestedSessionId: string,
): TaskRevisionStatus | null {
  const sessionId = assertSessionId(requestedSessionId);
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const journal =
    findLiveRevisionJournal(runtime, sessionId) ??
    findLatestRevisionJournal(runtime, sessionId);
  if (journal === null) return null;
  const retrySafe = !['completed', 'revoked'].includes(journal.phase);
  const retryCommand = revisionRetryCommand(journal);
  return {
    leaseId: journal.leaseId,
    sessionId: journal.sessionId,
    changeId: journal.changeId,
    taskId: journal.taskId,
    phase: journal.phase,
    reason: journal.reason,
    createdAt: journal.createdAt,
    expiresAt: journal.expiresAt,
    implementationFingerprint: journal.implementationFingerprint,
    implementationPaths: [...journal.implementationPaths],
    planCommitHash: journal.planCommitHash ?? null,
    planReportId: journal.planReportId ?? null,
    planChangedPaths: [...(journal.planChangedPaths ?? [])],
    approvalId: journal.approvalId ?? null,
    retrySafe,
    retryCommand,
  };
}

export function prepareTaskRevisionApprovalBinding(
  cwd: string,
  requestedSessionId: string,
  options: Pick<TaskRevisionOptions, 'now'> = {},
): TaskRevisionApprovalBinding {
  const sessionId = assertSessionId(requestedSessionId);
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) =>
    withSessionOperation(runtime, sessionId, () => {
      assertRepositoryLock();
      const current = readSessionFile(sessionPath(runtime, sessionId));
      const journal = findLiveRevisionJournal(runtime, sessionId);
      if (
        journal === null ||
        journal.phase !== 'revising' ||
        current.state !== 'revising' ||
        current.revisionLeaseId !== journal.leaseId
      ) {
        throw workflowError(
          'REVISION_APPROVAL_NOT_AVAILABLE',
          'A task-revision approval can be prepared only for an exact live widening lease before transition effects.',
          ExitCode.staleState,
        );
      }
      assertLeaseCurrent(journal, current, discovered.repositoryRoot);
      const now = trustedNow(options.now);
      if (now.getTime() >= Date.parse(journal.expiresAt)) {
        throw workflowError(
          'REVISION_LEASE_EXPIRED',
          'The task revision lease expired before widening approval preparation.',
          ExitCode.staleState,
        );
      }
      const planningPaths = assertResumePathState(
        discovered.repositoryRoot,
        config.changeRoot,
        current,
        journal,
      );
      if (planningPaths.length === 0) {
        throw workflowError(
          'REVISION_APPROVAL_NOT_REQUIRED',
          'An unchanged task contract does not require widening approval.',
          ExitCode.guard,
        );
      }
      const candidate = loadStableValidatedChangeContract(
        discovered,
        current.changeId,
      ).contract;
      const classification = classifyRevisionCandidate(
        current,
        journal,
        candidate,
      );
      if (classification.kind !== 'widening') {
        throw workflowError(
          'REVISION_APPROVAL_NOT_REQUIRED',
          'Scope-neutral and narrowing task revisions do not accept external widening authority.',
          ExitCode.guard,
        );
      }
      assertRepositoryLock();
      return classification.approvalBinding;
    }),
  );
}

export function prepareTaskRevisionAbort(
  runtime: ReturnType<typeof runtimePaths>,
  session: WorkflowSession,
  reason: string,
  now: Date = new Date(),
): TaskRevisionJournal | null {
  if (session.revisionLeaseId === undefined) return null;
  const journal = readRevisionJournal(runtime, session.revisionLeaseId);
  if (
    journal.sessionId !== session.sessionId ||
    journal.changeId !== session.changeId ||
    journal.taskId !== session.taskId
  ) {
    throw corruptRevisionState();
  }
  if (journal.phase === 'abort-prepared') {
    if (journal.abortReason !== reason) throw corruptRevisionState();
    return journal;
  }
  if (!['prepared', 'session-revising', 'revising'].includes(journal.phase)) {
    throw workflowError(
      'REVISION_ABORT_INVALID',
      `Revision lease ${journal.leaseId} is already ${journal.phase}.`,
      ExitCode.staleState,
    );
  }
  const timestamp = assertDate(now).toISOString();
  return transitionJournal(runtime, journal, {
    ...journal,
    phase: 'abort-prepared',
    abortPreparedAt: timestamp,
    abortReason: reason,
  });
}

export function completeTaskRevisionAbort(
  runtime: ReturnType<typeof runtimePaths>,
  session: WorkflowSession,
): TaskRevisionJournal | null {
  if (session.revisionLeaseId === undefined) return null;
  const journal = readRevisionJournal(runtime, session.revisionLeaseId);
  if (
    session.state !== 'aborted' ||
    journal.phase !== 'abort-prepared' ||
    journal.sessionId !== session.sessionId ||
    journal.abortReason !== session.abortReason
  ) {
    if (journal.phase === 'revoked' && session.state === 'aborted') {
      return journal;
    }
    throw corruptRevisionState();
  }
  return transitionJournal(runtime, journal, {
    ...journal,
    phase: 'revoked',
    revokedAt: session.abortedAt,
  });
}

function reconcileReviseTask(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  reason: string,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  if (journal.reason !== reason) {
    throw workflowError(
      'REVISION_LEASE_ALREADY_ACTIVE',
      'The session already has a revision lease for another exact reason.',
      ExitCode.conflict,
      { details: { leaseId: journal.leaseId, reason: journal.reason } },
    );
  }
  if (journal.phase === 'abort-prepared') {
    throw workflowError(
      'REVISION_ABORT_IN_PROGRESS',
      'The revision lease is already being terminally aborted.',
      ExitCode.staleState,
    );
  }
  if (journal.phase === 'resume-prepared') {
    throw workflowError(
      'REVISION_RESUME_IN_PROGRESS',
      'The revision lease is already being resumed.',
      ExitCode.staleState,
    );
  }
  if (current.state === 'active') {
    if (
      journal.phase !== 'prepared' ||
      digestValue(current) !== journal.sessionBeforeDigest
    ) {
      throw corruptRevisionState();
    }
    assertLeaseCurrent(journal, current, current.repositoryRoot);
    const inspection = inspectSession(cwd, current.sessionId, {
      expectedSession: current,
    });
    if (
      digestImplementationSnapshot(
        snapshotImplementationPaths(
          current.repositoryRoot,
          inspection.changedPaths,
        ),
      ) !== journal.implementationFingerprint
    ) {
      throw revisionDrift();
    }
    const revising = revisionSession(current, journal.leaseId);
    writeSessionCas(runtime, current, revising);
    const sessionRevising = transitionJournal(runtime, journal, {
      ...journal,
      phase: 'session-revising',
    });
    crashAfter(options, 'session-revising');
    const activeLease = transitionJournal(runtime, sessionRevising, {
      ...sessionRevising,
      phase: 'revising',
    });
    assertRepositoryLock();
    return { session: revising, lease: activeLease };
  }
  if (
    current.state !== 'revising' ||
    current.revisionLeaseId !== journal.leaseId ||
    !['prepared', 'session-revising', 'revising'].includes(journal.phase)
  ) {
    throw corruptRevisionState();
  }
  const activeLease =
    journal.phase === 'revising'
      ? journal
      : transitionJournal(runtime, journal, {
          ...journal,
          phase: 'revising',
        });
  assertRepositoryLock();
  return { session: current, lease: activeLease };
}

function completePreparedResume(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  if (!journal.resumeSessionDigest || !journal.resumePreparedAt) {
    throw corruptRevisionState();
  }
  let active = current;
  if (current.state === 'revising') {
    if (current.revisionLeaseId !== journal.leaseId) {
      throw corruptRevisionState();
    }
    active = activeSessionForPreparedResume(current, journal, options);
    if (digestValue(active) !== journal.resumeSessionDigest) {
      throw corruptRevisionState();
    }
    writeSessionCas(runtime, current, active);
    crashAfter(options, 'session-active');
  } else if (
    current.state !== 'active' ||
    digestValue(current) !== journal.resumeSessionDigest
  ) {
    throw corruptRevisionState();
  }
  assertRepositoryLock();
  const completed = transitionJournal(runtime, journal, {
    ...journal,
    phase: 'completed',
    completedAt: journal.resumePreparedAt,
  });
  return { session: active, lease: completed };
}

function activeSessionForPreparedResume(
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
): WorkflowSession {
  if (!journal.planCommitHash) {
    assertNoOpResumeState(
      current.repositoryRoot,
      loadWorkflowConfig(current.repositoryRoot).changeRoot,
      current,
      journal,
    );
    return activeSessionAfterNoOpRevision(current);
  }
  if (!journal.planTree) throw corruptRevisionState();
  const discovered = discoverRepository(current.repositoryRoot);
  if (
    discovered.repositoryRealPath !== journal.repositoryRoot ||
    discovered.gitCommonDirectory !== journal.gitCommonDirectory ||
    discovered.branch !== journal.branch ||
    discovered.head !== journal.planCommitHash ||
    discovered.tree !== journal.planTree ||
    runGit(discovered.repositoryRoot, ['write-tree']).trim() !==
      journal.planTree ||
    canonicalJson(
      listChangedPaths(discovered.repositoryRoot, discovered.head),
    ) !== canonicalJson(journal.implementationPaths) ||
    canonicalJson(
      snapshotImplementationPaths(
        discovered.repositoryRoot,
        journal.implementationPaths,
      ),
    ) !== canonicalJson(journal.implementationSnapshot)
  ) {
    throw revisionDrift();
  }
  const contract = loadStableValidatedChangeContract(
    discovered,
    current.changeId,
  ).contract;
  assertRevisionCandidateAuthorized(
    current.repositoryRoot,
    current,
    journal,
    contract,
    options,
    true,
  );
  return activeSessionAfterPlanningRevision(
    current,
    journal.planCommitHash,
    journal.planTree,
    contract,
  );
}

function commitPlanningRevision(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  const before = discoverRepository(current.repositoryRoot);
  const candidate = loadStableValidatedChangeContract(
    before,
    current.changeId,
  ).contract;
  const approvalId = assertRevisionCandidateAuthorized(
    current.repositoryRoot,
    current,
    journal,
    candidate,
    options,
    journal.phase !== 'revising',
  );

  let durableJournal = journal;
  const transition = withTaskRevisionPlanningAuthority(
    runtime,
    current,
    journal.leaseId,
    assertRepositoryLock,
    (authority) =>
      commitTaskRevisionPlanningTransitionUnderAuthority(
        cwd,
        current.changeId,
        authority,
        journal.implementationPaths,
        process.env,
        {
          beforeStagingMutation: (context) => {
            if (durableJournal.phase === 'revising') {
              if (
                context.previousIndexTree !== durableJournal.indexTree ||
                canonicalJson(context.preservedUnstagedPaths) !==
                  canonicalJson(durableJournal.implementationPaths)
              ) {
                throw corruptRevisionState();
              }
              durableJournal = transitionJournal(runtime, durableJournal, {
                ...durableJournal,
                phase: 'planning-staging-prepared',
                stagingTree: context.tree,
                stagingChangedPaths: [...context.changedPaths].sort(),
                stagingGeneratedMutations: context.generatedMutations.map(
                  (mutation) => ({
                    path: mutation.path,
                    before: mutation.before ?? null,
                    after: mutation.after,
                  }),
                ),
                stagingPreparedAt: trustedNow(options.now).toISOString(),
                ...(approvalId === null ? {} : { approvalId }),
              });
            } else if (
              durableJournal.phase !== 'planning-staging-prepared' ||
              durableJournal.stagingTree !== context.tree ||
              canonicalJson(durableJournal.stagingChangedPaths) !==
                canonicalJson([...context.changedPaths].sort()) ||
              canonicalJson(durableJournal.stagingGeneratedMutations) !==
                canonicalJson(
                  context.generatedMutations.map((mutation) => ({
                    path: mutation.path,
                    before: mutation.before ?? null,
                    after: mutation.after,
                  })),
                ) ||
              context.previousIndexTree !== durableJournal.indexTree ||
              (durableJournal.approvalId ?? null) !== approvalId ||
              canonicalJson(context.preservedUnstagedPaths) !==
                canonicalJson(durableJournal.implementationPaths)
            ) {
              throw corruptRevisionState();
            }
            crashAfter(options, 'planning-staging-prepared');
          },
          beforeRefUpdate: (context) => {
            if (
              durableJournal.phase !== 'planning-staging-prepared' ||
              durableJournal.stagingTree !== context.tree ||
              canonicalJson(durableJournal.stagingChangedPaths) !==
                canonicalJson([...context.changedPaths].sort())
            ) {
              throw corruptRevisionState();
            }
            durableJournal = transitionJournal(runtime, durableJournal, {
              ...durableJournal,
              phase: 'plan-commit-prepared',
              planCommitHash: context.commitHash,
              planTree: context.tree,
              planReportId: context.reportId,
              planChangedPaths: [...context.changedPaths].sort(),
            });
            crashAfter(options, 'plan-commit-prepared');
          },
          afterRefUpdateBeforeEpoch: (context) => {
            if (
              durableJournal.phase !== 'plan-commit-prepared' ||
              durableJournal.planCommitHash !== context.commitHash ||
              durableJournal.planReportId !== context.reportId
            ) {
              throw corruptRevisionState();
            }
            durableJournal = transitionJournal(runtime, durableJournal, {
              ...durableJournal,
              phase: 'plan-committed',
              planCommittedAt: trustedNow(options.now).toISOString(),
            });
            crashAfter(options, 'plan-ref-updated');
          },
        },
      ),
  );
  if (durableJournal.phase !== 'plan-committed') {
    throw corruptRevisionState();
  }
  assertRepositoryLock();
  const after = discoverRepository(current.repositoryRoot);
  if (
    after.head !== transition.commitHash ||
    after.tree !== transition.tree ||
    canonicalJson(listChangedPaths(after.repositoryRoot, after.head)) !==
      canonicalJson(journal.implementationPaths) ||
    runGit(after.repositoryRoot, ['write-tree']).trim() !== transition.tree
  ) {
    throw revisionDrift();
  }
  const snapshot = snapshotImplementationPaths(
    after.repositoryRoot,
    journal.implementationPaths,
  );
  if (
    canonicalJson(snapshot) !== canonicalJson(journal.implementationSnapshot)
  ) {
    throw revisionDrift();
  }
  const committed = loadStableValidatedChangeContract(
    after,
    current.changeId,
  ).contract;
  if (committed.contractDigest !== candidate.contractDigest) {
    throw workflowError(
      'REVISION_CONTRACT_CHANGED',
      'The committed task revision contract differs from its reviewed candidate.',
      ExitCode.staleState,
    );
  }
  const active = activeSessionAfterPlanningRevision(
    current,
    transition.commitHash,
    transition.tree,
    committed,
  );
  const now = trustedNow(options.now).toISOString();
  const prepared = transitionJournal(runtime, durableJournal, {
    ...durableJournal,
    phase: 'resume-prepared',
    resumePreparedAt: now,
    resumeSessionDigest: digestValue(active),
    planCommitHash: transition.commitHash,
    planTree: transition.tree,
    planReportId: transition.reportId,
    planChangedPaths: [...transition.changedPaths],
    planCommittedAt: now,
  });
  crashAfter(options, 'resume-prepared');
  writeSessionCas(runtime, current, active);
  crashAfter(options, 'session-active');
  const completed = transitionJournal(runtime, prepared, {
    ...prepared,
    phase: 'completed',
    completedAt: now,
  });
  return { session: active, lease: completed };
}

function completeCommittedPlanningRevision(
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  if (
    current.state !== 'revising' ||
    current.revisionLeaseId !== journal.leaseId ||
    journal.phase !== 'plan-committed' ||
    !journal.planCommitHash ||
    !journal.planTree
  ) {
    throw corruptRevisionState();
  }
  assertRepositoryLock();
  const discovered = discoverRepository(current.repositoryRoot);
  if (
    discovered.repositoryRealPath !== journal.repositoryRoot ||
    discovered.gitCommonDirectory !== journal.gitCommonDirectory ||
    discovered.branch !== journal.branch ||
    discovered.head !== journal.planCommitHash ||
    discovered.tree !== journal.planTree ||
    runGit(discovered.repositoryRoot, ['write-tree']).trim() !==
      journal.planTree ||
    canonicalJson(
      listChangedPaths(discovered.repositoryRoot, discovered.head),
    ) !== canonicalJson(journal.implementationPaths) ||
    canonicalJson(
      snapshotImplementationPaths(
        discovered.repositoryRoot,
        journal.implementationPaths,
      ),
    ) !== canonicalJson(journal.implementationSnapshot)
  ) {
    throw revisionDrift();
  }
  const contract = loadStableValidatedChangeContract(
    discovered,
    current.changeId,
  ).contract;
  assertRevisionCandidateAuthorized(
    current.repositoryRoot,
    current,
    journal,
    contract,
    options,
    true,
  );
  const active = activeSessionAfterPlanningRevision(
    current,
    journal.planCommitHash,
    journal.planTree,
    contract,
  );
  const now = trustedNow(options.now).toISOString();
  const prepared = transitionJournal(runtime, journal, {
    ...journal,
    phase: 'resume-prepared',
    resumePreparedAt: now,
    resumeSessionDigest: digestValue(active),
  });
  crashAfter(options, 'resume-prepared');
  writeSessionCas(runtime, current, active);
  crashAfter(options, 'session-active');
  assertRepositoryLock();
  const completed = transitionJournal(runtime, prepared, {
    ...prepared,
    phase: 'completed',
    completedAt: now,
  });
  return { session: active, lease: completed };
}

function recoverPreparedPlanningRevision(
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  if (
    current.state !== 'revising' ||
    current.revisionLeaseId !== journal.leaseId ||
    journal.phase !== 'plan-commit-prepared' ||
    !journal.planCommitHash ||
    !journal.planTree
  ) {
    throw corruptRevisionState();
  }
  assertRepositoryLock();
  let discovered = discoverRepository(current.repositoryRoot);
  const report = readPlanningTransitionReport(
    path.join(runtime.root, 'planning-reports'),
    journal.planReportId!,
  );
  const facts = commitFacts(discovered.repositoryRoot, journal.planCommitHash);
  if (
    report.changeId !== journal.changeId ||
    report.transition !== 'plan' ||
    report.parent.head !== journal.head ||
    report.parent.tree !== journal.tree ||
    report.commitHash !== journal.planCommitHash ||
    report.tree !== journal.planTree ||
    report.reportVersion !== 3 ||
    canonicalJson(report.changedPaths) !==
      canonicalJson(journal.planChangedPaths) ||
    facts.tree !== journal.planTree ||
    canonicalJson(facts.parents) !== canonicalJson([journal.head]) ||
    facts.message !== `${report.message}\n` ||
    canonicalJson(
      commitChangedPaths(discovered.repositoryRoot, journal.planCommitHash),
    ) !== canonicalJson(journal.planChangedPaths)
  ) {
    throw corruptRevisionState();
  }
  if (discovered.head === journal.head) {
    const currentIndexTree = runGit(discovered.repositoryRoot, [
      'write-tree',
    ]).trim();
    if (currentIndexTree === journal.indexTree) {
      refreshPlanningDocuments(
        discovered.repositoryRoot,
        journal.changeId,
        loadChangeContract(discovered.repositoryRoot, journal.changeId)
          .investigation?.manifest,
      );
      const expectedChanged = [
        ...journal.planChangedPaths!,
        ...journal.implementationPaths,
      ].sort();
      if (
        canonicalJson(
          listChangedPaths(discovered.repositoryRoot, journal.head),
        ) !== canonicalJson(expectedChanged)
      ) {
        throw revisionDrift();
      }
      const staged = stageExactPathsPreservingUnstaged(
        discovered.repositoryRoot,
        journal.head,
        journal.planChangedPaths!,
        journal.implementationPaths,
      );
      if (
        staged.previousIndexTree !== journal.indexTree ||
        staged.tree !== journal.planTree
      ) {
        throw corruptRevisionState();
      }
    } else if (currentIndexTree === journal.planTree) {
      if (
        canonicalJson(
          listStagedPaths(discovered.repositoryRoot, journal.head),
        ) !== canonicalJson(journal.planChangedPaths) ||
        canonicalJson(
          listChangedPaths(discovered.repositoryRoot, journal.head).filter(
            (candidate) => !journal.planChangedPaths!.includes(candidate),
          ),
        ) !== canonicalJson(journal.implementationPaths)
      ) {
        throw revisionDrift();
      }
    } else {
      throw revisionDrift();
    }
    assertRepositoryLock();
    updateManagedRef(
      discovered.repositoryRoot,
      journal.head,
      journal.planCommitHash,
      `refs/heads/${journal.branch}`,
    );
    discovered = discoverRepository(current.repositoryRoot);
  }
  if (
    discovered.head !== journal.planCommitHash ||
    discovered.tree !== journal.planTree ||
    runGit(discovered.repositoryRoot, ['write-tree']).trim() !==
      journal.planTree
  ) {
    throw revisionDrift();
  }
  const committed = transitionJournal(runtime, journal, {
    ...journal,
    phase: 'plan-committed',
    planCommittedAt: trustedNow(options.now).toISOString(),
  });
  return completeCommittedPlanningRevision(
    runtime,
    current,
    committed,
    options,
    assertRepositoryLock,
  );
}

function recoverPreparedPlanningStaging(
  cwd: string,
  runtime: ReturnType<typeof runtimePaths>,
  current: WorkflowSession,
  journal: TaskRevisionJournal,
  options: TaskRevisionOptions,
  assertRepositoryLock: () => void,
): TaskRevisionResult {
  if (
    current.state !== 'revising' ||
    current.revisionLeaseId !== journal.leaseId ||
    journal.phase !== 'planning-staging-prepared' ||
    !journal.stagingTree
  ) {
    throw corruptRevisionState();
  }
  assertRepositoryLock();
  const discovered = discoverRepository(current.repositoryRoot);
  if (
    discovered.repositoryRealPath !== journal.repositoryRoot ||
    discovered.gitCommonDirectory !== journal.gitCommonDirectory ||
    discovered.branch !== journal.branch ||
    discovered.head !== journal.head ||
    discovered.tree !== journal.tree ||
    canonicalJson(
      snapshotImplementationPaths(
        discovered.repositoryRoot,
        journal.implementationPaths,
      ),
    ) !== canonicalJson(journal.implementationSnapshot)
  ) {
    throw revisionDrift();
  }
  const indexTree = runGit(discovered.repositoryRoot, ['write-tree']).trim();
  if (indexTree === journal.stagingTree) {
    runGit(discovered.repositoryRoot, ['read-tree', journal.indexTree]);
  } else if (indexTree !== journal.indexTree) {
    throw revisionDrift();
  }
  reconcilePreparedGeneratedDocuments(
    discovered.repositoryRoot,
    journal.stagingGeneratedMutations ?? [],
  );
  assertRepositoryLock();
  return commitPlanningRevision(
    cwd,
    runtime,
    current,
    journal,
    options,
    assertRepositoryLock,
  );
}

function reconcilePreparedGeneratedDocuments(
  repositoryRoot: string,
  mutations: readonly StagingGeneratedMutation[],
): void {
  for (const mutation of mutations) {
    const absolute = path.join(repositoryRoot, mutation.path);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
      throw revisionDrift();
    }
    const current = stats ? fs.readFileSync(absolute, 'utf8') : null;
    if (current === mutation.before) continue;
    if (current !== mutation.after) throw revisionDrift();
    rollbackGeneratedDocuments(repositoryRoot, [
      {
        path: mutation.path,
        before: mutation.before ?? undefined,
        after: mutation.after,
      },
    ]);
  }
}

type RevisionCandidateClassification =
  | Readonly<{ kind: 'scope-neutral-or-narrowing' }>
  | Readonly<{
      kind: 'widening';
      approvalBinding: TaskRevisionApprovalBinding;
    }>;

function classifyRevisionCandidate(
  session: WorkflowSession,
  journal: TaskRevisionJournal,
  contract: ReturnType<typeof loadStableValidatedChangeContract>['contract'],
): RevisionCandidateClassification {
  const task = contract.tasks.find(
    (candidate) => candidate.id === session.taskId,
  );
  const policy = contract.guard.tasks[session.taskId];
  const planningAssurance = contract.planningAssurance;
  if (!task || task.completed || !policy) {
    throw workflowError(
      'REVISION_TASK_CONTRACT_INVALID',
      'The revised plan must retain the exact incomplete task being resumed.',
      ExitCode.guard,
    );
  }
  if (
    planningAssurance === null ||
    planningAssurance.investigationBaseline.head !== journal.head ||
    planningAssurance.investigationBaseline.tree !== journal.tree ||
    planningAssurance.planningGenerationId ===
      journal.planningAssurance?.planningGenerationId
  ) {
    throw workflowError(
      'REVISION_PLAN_REVIEW_REQUIRED',
      'A task revision requires a fresh PlanReview bound to the exact pre-revision task baseline.',
      ExitCode.verification,
    );
  }
  const allowedPathsAreNarrower = policy.allowedPaths.every((candidate) =>
    journal.allowedPaths.some((prior) => policyPathContains(prior, candidate)),
  );
  const checksAreNotWeaker = journal.requiredChecks.every((candidate) =>
    policy.requiredChecks.includes(candidate),
  );
  const outside = journal.implementationPaths.filter(
    (changedPath) =>
      !policy.allowedPaths.some((allowedPath) =>
        matchesAllowedPath(changedPath, allowedPath),
      ),
  );
  if (outside.length > 0) {
    throw workflowError(
      'REVISION_IMPLEMENTATION_OUT_OF_SCOPE',
      'The revised task policy excludes implementation bytes already held by the session.',
      ExitCode.guard,
      { details: { paths: outside } },
    );
  }
  if (allowedPathsAreNarrower && checksAreNotWeaker) {
    return { kind: 'scope-neutral-or-narrowing' };
  }
  return {
    kind: 'widening',
    approvalBinding: {
      schemaVersion: 1,
      kind: 'task-revision-approval-binding.v1',
      changeId: journal.changeId,
      taskId: journal.taskId,
      sessionId: journal.sessionId,
      leaseId: journal.leaseId,
      actorAuthorityId: journal.actorAuthorityId,
      baselineCommit: journal.head,
      baselineTree: journal.tree,
      priorContractDigest: journal.contractDigest,
      candidateContractDigest: contract.contractDigest,
      candidatePlanningGenerationId: planningAssurance.planningGenerationId,
      implementationFingerprint: journal.implementationFingerprint,
      revisionReasonDigest: crypto
        .createHash('sha256')
        .update('task-revision-reason.v1\0')
        .update(journal.reason)
        .digest('hex'),
      previousAllowedPaths: [...journal.allowedPaths].sort(),
      nextAllowedPaths: [...policy.allowedPaths].sort(),
      previousRequiredChecks: [...journal.requiredChecks].sort(),
      nextRequiredChecks: [...policy.requiredChecks].sort(),
    },
  };
}

function assertRevisionCandidateAuthorized(
  cwd: string,
  session: WorkflowSession,
  journal: TaskRevisionJournal,
  contract: ReturnType<typeof loadStableValidatedChangeContract>['contract'],
  options: TaskRevisionOptions,
  allowExpired: boolean,
): string | null {
  const classification = classifyRevisionCandidate(session, journal, contract);
  if (classification.kind === 'scope-neutral-or-narrowing') {
    if (journal.approvalId !== undefined) throw corruptRevisionState();
    return null;
  }
  const approvalId = journal.approvalId ?? options.approvalId;
  if (approvalId === undefined) {
    const approvalTargetDigest = taskRevisionApprovalTargetDigest(
      classification.approvalBinding,
    );
    throw workflowError(
      'REVISION_REQUIRES_APPROVAL',
      'A task revision that widens path or check authority requires an external non-benefiting approval.',
      ExitCode.guard,
      {
        details: {
          approvalTargetDigest,
          previousAllowedPaths:
            classification.approvalBinding.previousAllowedPaths,
          nextAllowedPaths: classification.approvalBinding.nextAllowedPaths,
          previousRequiredChecks:
            classification.approvalBinding.previousRequiredChecks,
          nextRequiredChecks: classification.approvalBinding.nextRequiredChecks,
        },
        recovery: `A controlling maintainer may issue the exact decision with pnpm workflow maintainer revision-approval ${journal.sessionId} --target ${approvalTargetDigest} --reason <text> --json, then retry resume-task with --approval <approval-id>.`,
      },
    );
  }
  if (
    journal.approvalId !== undefined &&
    options.approvalId !== undefined &&
    options.approvalId !== journal.approvalId
  ) {
    throw corruptRevisionState();
  }
  readAndValidateTaskRevisionApproval(
    cwd,
    approvalId,
    classification.approvalBinding,
    {
      now: trustedNow(options.now),
      allowExpired,
      verifier: options.approvalVerifier,
    },
  );
  return approvalId;
}

function policyPathContains(container: string, candidate: string): boolean {
  const outer = normalizePolicyPath(container);
  const inner = normalizePolicyPath(candidate);
  if (!inner.endsWith('/**')) return matchesAllowedPath(inner, outer);
  if (!outer.endsWith('/**')) return false;
  const outerBase = outer.slice(0, -3);
  const innerBase = inner.slice(0, -3);
  return innerBase === outerBase || innerBase.startsWith(`${outerBase}/`);
}

function assertNoOpResumeState(
  repositoryRoot: string,
  changeRoot: string,
  session: WorkflowSession,
  journal: TaskRevisionJournal,
): void {
  const planningPaths = assertResumePathState(
    repositoryRoot,
    changeRoot,
    session,
    journal,
  );
  if (planningPaths.length > 0) {
    throw workflowError(
      'REVISION_PLAN_COMMIT_REQUIRED',
      'Planning changes require the journaled temporary-index revision transition before execution can resume.',
      ExitCode.verification,
      { details: { planningPaths } },
    );
  }
  assertNoOpResumeContract(repositoryRoot, session, journal);
}

function assertResumePathState(
  repositoryRoot: string,
  changeRoot: string,
  session: WorkflowSession,
  journal: TaskRevisionJournal,
): string[] {
  assertLeaseCurrent(journal, session, repositoryRoot);
  const changedPaths = listChangedPaths(repositoryRoot, journal.head);
  const expected = journal.implementationPaths;
  const expectedSet = new Set(expected);
  const extra = changedPaths.filter((candidate) => !expectedSet.has(candidate));
  const missing = expected.filter(
    (candidate) => !changedPaths.includes(candidate),
  );
  const planningPrefix = `${changeRoot}/${session.changeId}/`;
  if (
    missing.length > 0 ||
    extra.some((candidate) => !candidate.startsWith(planningPrefix))
  ) {
    throw revisionDrift();
  }
  const snapshot = snapshotImplementationPaths(repositoryRoot, expected);
  if (
    digestImplementationSnapshot(snapshot) !==
      journal.implementationFingerprint ||
    canonicalJson(snapshot) !== canonicalJson(journal.implementationSnapshot)
  ) {
    throw revisionDrift();
  }
  return extra;
}

function assertNoOpResumeContract(
  repositoryRoot: string,
  session: WorkflowSession,
  journal: TaskRevisionJournal,
): void {
  const discovered = discoverRepository(repositoryRoot);
  const { contract } = loadStableValidatedChangeContract(
    discovered,
    session.changeId,
  );
  const policy = contract.guard.tasks[session.taskId];
  if (
    !policy ||
    contract.contractDigest !== journal.contractDigest ||
    canonicalJson(contract.artifactDigests) !==
      canonicalJson(journal.artifactDigests) ||
    canonicalJson(policy.allowedPaths) !==
      canonicalJson(journal.allowedPaths) ||
    canonicalJson(policy.requiredChecks) !==
      canonicalJson(journal.requiredChecks) ||
    canonicalJson(
      digestRequiredCheckDefinitions(contract.checks, policy.requiredChecks),
    ) !== canonicalJson(journal.requiredCheckDigests) ||
    canonicalJson(
      createTaskPlanningAssuranceBinding(contract, contract.planningAssurance),
    ) !== canonicalJson(journal.planningAssurance ?? null)
  ) {
    throw workflowError(
      'REVISION_CONTRACT_CHANGED',
      'The no-op resume contract differs from the contract frozen by revise-task.',
      ExitCode.staleState,
    );
  }
}

function assertLeaseCurrent(
  journal: TaskRevisionJournal,
  session: WorkflowSession,
  repositoryRoot: string,
): void {
  const discovered = discoverRepository(repositoryRoot);
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    discovered.repositoryRealPath !== journal.repositoryRoot ||
    discovered.gitCommonDirectory !== journal.gitCommonDirectory ||
    discovered.branch !== journal.branch ||
    discovered.head !== journal.head ||
    session.repositoryRoot !== journal.repositoryRoot ||
    session.gitCommonDirectory !== journal.gitCommonDirectory ||
    session.branch !== journal.branch ||
    session.baseline.head !== journal.head ||
    session.baseline.tree !== journal.tree ||
    session.changeId !== journal.changeId ||
    session.taskId !== journal.taskId ||
    indexTree !== journal.indexTree
  ) {
    throw revisionDrift();
  }
}

function revisionSession(
  session: WorkflowSession,
  leaseId: string,
): WorkflowSession {
  const {
    latestCheckReportId: _latestCheckReportId,
    checkEvidenceEngineDigest: _checkEvidenceEngineDigest,
    implementationReconciliationReportId: _reconciliationReportId,
    implementationReconciliationPaths: _reconciliationPaths,
    ...preserved
  } = session;
  return {
    ...preserved,
    state: 'revising',
    revisionLeaseId: leaseId,
  };
}

function activeSessionAfterNoOpRevision(
  session: WorkflowSession,
): WorkflowSession {
  const { revisionLeaseId: _revisionLeaseId, ...preserved } = session;
  return { ...preserved, state: 'active' };
}

function activeSessionAfterPlanningRevision(
  session: WorkflowSession,
  head: string,
  tree: string,
  contract: ReturnType<typeof loadStableValidatedChangeContract>['contract'],
): WorkflowSession {
  const policy = contract.guard.tasks[session.taskId];
  if (!policy) throw corruptRevisionState();
  const { revisionLeaseId: _revisionLeaseId, ...preserved } = session;
  return {
    ...preserved,
    state: 'active',
    baseline: { head, tree },
    artifacts: { ...contract.artifactDigests },
    allowedPaths: [...policy.allowedPaths],
    requiredChecks: [...policy.requiredChecks],
    requiredCheckDigests: digestRequiredCheckDefinitions(
      contract.checks,
      policy.requiredChecks,
    ),
    planningAssurance: createTaskPlanningAssuranceBinding(
      contract,
      contract.planningAssurance,
    ),
  };
}

function assertRevisionSessionEligible(session: WorkflowSession): void {
  if (
    session.completionReportId ||
    session.finishReportId ||
    session.commitReportId ||
    session.commitHash ||
    session.implementationReconciliationReportId
  ) {
    throw workflowError(
      'REVISION_SESSION_NOT_ELIGIBLE',
      'revise-task requires an unprojected and uncommitted active session.',
      ExitCode.staleState,
    );
  }
}

function assertImplementationPlanningDisjoint(
  implementationPaths: readonly string[],
  changeRoot: string,
  changeId: string,
): void {
  const prefix = `${changeRoot}/${changeId}/`;
  const overlapping = implementationPaths.filter((candidate) =>
    candidate.startsWith(prefix),
  );
  if (overlapping.length > 0) {
    throw workflowError(
      'REVISION_AUTHORITY_OVERLAP',
      'Task implementation and planning authority paths must be disjoint.',
      ExitCode.guard,
      { details: { paths: overlapping } },
    );
  }
}

function writeSessionCas(
  runtime: ReturnType<typeof runtimePaths>,
  expected: WorkflowSession,
  next: WorkflowSession,
): void {
  const filePath = sessionPath(runtime, expected.sessionId);
  const current = readSessionFile(filePath);
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The session changed during its task revision transition.',
      ExitCode.staleState,
    );
  }
  writeJsonAtomic(filePath, next);
  if (canonicalJson(readSessionFile(filePath)) !== canonicalJson(next)) {
    throw corruptRevisionState();
  }
}

function listStagedPaths(
  repositoryRoot: string,
  baselineHead: string,
): string[] {
  return runGit(repositoryRoot, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '-z',
    baselineHead,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeChangedPath)
    .sort();
}

function sessionPath(
  runtime: ReturnType<typeof runtimePaths>,
  sessionId: string,
): string {
  return path.join(runtime.sessions, `${sessionId}.json`);
}

function revisionRetryCommand(journal: TaskRevisionJournal): string | null {
  if (journal.phase === 'completed' || journal.phase === 'revoked') return null;
  if (journal.phase === 'abort-prepared') {
    return `pnpm workflow abort ${journal.sessionId} --reason ${JSON.stringify(
      journal.abortReason ?? 'Abort task revision',
    )} --json`;
  }
  if (journal.phase === 'prepared' || journal.phase === 'session-revising') {
    return `pnpm workflow revise-task ${journal.sessionId} --reason ${JSON.stringify(
      journal.reason,
    )} --json`;
  }
  return `pnpm workflow resume-task ${journal.sessionId} --json`;
}

function assertRevisionReason(value: string): string {
  const reason = value.trim();
  if (!reason || reason.length > 500) {
    throw workflowError(
      'REVISION_REASON_REQUIRED',
      'revise-task requires a non-empty reason of at most 500 characters.',
      ExitCode.usage,
    );
  }
  return reason;
}

function trustedNow(provider: (() => Date) | undefined): Date {
  return assertDate((provider ?? (() => new Date()))());
}

function assertDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw workflowError(
      'REVISION_CLOCK_INVALID',
      'The trusted task revision clock is invalid.',
      ExitCode.staleState,
    );
  }
  return value;
}

function crashAfter(
  options: TaskRevisionOptions,
  point: NonNullable<TaskRevisionOptions['testCrashAfter']>,
): void {
  if (options.testCrashAfter === point) {
    throw new Error(`simulated task revision crash after ${point}`);
  }
}

function sessionNotActive(session: WorkflowSession) {
  return workflowError(
    'SESSION_NOT_ACTIVE',
    `Session ${session.sessionId} is ${session.state}.`,
    ExitCode.staleState,
  );
}
