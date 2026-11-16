/** Observes baseline task authority and exact protected Apply lifecycle state. */
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type TaskAuthorizationRequirement,
  parseTaskAuthorizationPolicyFromWorkflowConfig,
  resolveTaskAuthorizationRequirementForPolicy,
} from '../../modules/repository-consumer/task-authorization-policy.ts';
import { readFileAtRevision } from '../repository-transaction/git-command.ts';
import { parsePathRoleRegistry } from '../../modules/source/path-role-registry.ts';
import {
  type FinalizeTransaction,
  type ProtectedTaskApplyAuthorizationBinding,
} from '../../modules/lifecycle/finalize-transaction.ts';
import {
  listChangedPaths,
  discoverRepository,
  fingerprintRepositoryProjection,
} from '../repository-transaction/git.ts';
import type { ProtectedTaskApplyFinalizationParametersV1 } from '../../modules/authority/protected-task-apply-grant.ts';
import type { ProtectedTaskApplyLifecycleState } from '../../modules/lifecycle/finalization.ts';
import { validateCommitSubject } from '../repository-transaction/git-transitions.ts';
import {
  getSession,
  loadActiveSessionContext,
} from '../repository-observation/workflow-session-context.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { readFinalizeTransaction } from '../storage-journal/finalize-transaction.ts';
import {
  protectedTaskApplyAuthorizationInvalid,
  assertFinalizeTransactionMatchesSession,
  assertProtectedApplyAuthorizationMatchesParameters,
  protectedTaskApplyFingerprint,
  assertProtectedTaskApplyParametersMatch,
} from '../../modules/lifecycle/finalization.ts';
import { readProtectedFinalizeCancellation } from '../storage-journal/finalize-cancellation.ts';
import { assertPreparedProtectedTaskApplyAuthorization } from '../repository-validation/protected-task-apply-authorization.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export function assertProtectedTaskApplyNotRequired(
  repositoryRoot: string,
  config: ReturnType<typeof loadWorkflowConfig>,
  session: WorkflowSession,
  changedPaths: readonly string[],
): void {
  const engineOwnedPaths = new Set(
    session.implementationReconciliationPaths ?? [],
  );
  const taskAuthoredPaths = changedPaths.filter(
    (changedPath) => !engineOwnedPaths.has(changedPath),
  );
  const requirement = resolveTaskAuthorizationRequirementAtBaseline(
    repositoryRoot,
    session.baseline.head,
    config,
    taskAuthoredPaths,
  );
  if (requirement === null || !requirement.requiresMandate) return;
  if (session.mandateBinding === undefined || session.mandateBinding === null) {
    throw workflowError(
      'TASK_MANDATE_REQUIRED',
      'The actual task diff intersects protected repository paths but the session has no Task Mandate.',
      ExitCode.guard,
      {
        details: {
          changeId: session.changeId,
          taskId: session.taskId,
          changedPaths: taskAuthoredPaths,
          roles: requirement.roles,
          matchedPatterns: requirement.matchedPatterns,
          unclassifiedScope: requirement.unclassifiedScope,
        },
        recovery:
          'Abort this session, authorize the protected task scope, and reopen the task with --mandate <mandate-task-id>.',
      },
    );
  }
  throw workflowError(
    'PROTECTED_TASK_APPLY_REQUIRED',
    'Protected task finalization requires the exact Central Grant transition.',
    ExitCode.guard,
    {
      details: {
        changeId: session.changeId,
        taskId: session.taskId,
        mandateTaskId: session.mandateBinding.mandateTaskId,
        changedPaths: taskAuthoredPaths,
        roles: requirement.roles,
        matchedPatterns: requirement.matchedPatterns,
        unclassifiedScope: requirement.unclassifiedScope,
      },
      recovery: `pnpm workflow finalize ${session.sessionId} --message "<subject>" --json`,
    },
  );
}

function resolveTaskAuthorizationRequirementAtBaseline(
  repositoryRoot: string,
  baselineHead: string,
  currentConfig: ReturnType<typeof loadWorkflowConfig>,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement | null {
  let baselineConfig: unknown;
  try {
    baselineConfig = JSON.parse(
      readFileAtRevision(repositoryRoot, baselineHead, 'workflow/config.json'),
    );
  } catch {
    throw baselineTaskAuthorizationInvalid(
      'Baseline workflow configuration is unavailable or malformed.',
    );
  }
  const baselinePolicy =
    parseTaskAuthorizationPolicyFromWorkflowConfig(baselineConfig);
  if (baselinePolicy === null) {
    if (currentConfig.taskAuthorization !== undefined) {
      throw baselineTaskAuthorizationInvalid(
        'An uncommitted task authorization policy cannot reclassify the active session.',
      );
    }
    return null;
  }
  try {
    const registry = parsePathRoleRegistry(
      JSON.parse(
        readFileAtRevision(
          repositoryRoot,
          baselineHead,
          `${baselinePolicy.pathRoleRegistry}`,
        ),
      ),
    );
    return resolveTaskAuthorizationRequirementForPolicy(
      baselinePolicy,
      registry,
      allowedPaths,
    );
  } catch {
    throw baselineTaskAuthorizationInvalid(
      'Baseline task authorization path-role registry is unavailable or malformed.',
    );
  }
}

function baselineTaskAuthorizationInvalid(message: string) {
  return workflowError(
    'TASK_AUTHORIZATION_POLICY_INVALID',
    message,
    ExitCode.guard,
  );
}

export function finalizeTransactionTaskPaths(
  transaction: FinalizeTransaction,
  session: WorkflowSession,
): string[] {
  const changedPaths =
    transaction.changedPaths.length > 0
      ? [...transaction.changedPaths]
      : listChangedPaths(transaction.repositoryRoot, transaction.baseline.head);
  const engineOwnedPaths = new Set([
    transaction.taskProjectionPath,
    ...transaction.transitionPaths,
    ...(session.implementationReconciliationPaths ?? []),
  ]);
  return changedPaths.filter(
    (changedPath) => !engineOwnedPaths.has(changedPath),
  );
}

export function inspectProtectedTaskApplyLifecycleState(
  cwd: string,
  requestedSessionId: string,
  commitMessage: string,
  fullGate: boolean,
  expectedParameters?: ProtectedTaskApplyFinalizationParametersV1,
  expectedParentChallengeId?: string,
): ProtectedTaskApplyLifecycleState {
  validateCommitSubject(commitMessage);
  const session = getSession(cwd, requestedSessionId);
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  const mandateBinding = session.mandateBinding;
  if (mandateBinding === undefined || mandateBinding === null) {
    throw protectedTaskApplyAuthorizationInvalid(
      'Protected Apply requires the session exact Task Mandate binding.',
    );
  }

  if (transaction === null) {
    const cancellation =
      expectedParentChallengeId === undefined
        ? null
        : readProtectedFinalizeCancellation(
            runtime.root,
            session.sessionId,
            expectedParentChallengeId,
          );
    if (cancellation !== null) {
      if (
        cancellation.phase !== 'completed' ||
        cancellation.cancelledAt === null ||
        cancellation.transaction.protectedApply === undefined ||
        expectedParameters === undefined
      ) {
        throw protectedTaskApplyAuthorizationInvalid(
          'Protected Apply cancellation is not durably complete.',
        );
      }
      assertFinalizeTransactionMatchesSession(
        cancellation.transaction,
        session,
        git,
      );
      assertPreparedProtectedTaskApplyAuthorization(
        runtime.root,
        cancellation.transaction.protectedApply,
        expectedParameters,
      );
      assertProtectedApplyAuthorizationMatchesParameters(
        cancellation.transaction.protectedApply,
        expectedParameters,
      );
      const changedPaths = finalizeTransactionTaskPaths(
        cancellation.transaction,
        session,
      );
      return Object.freeze({
        phase: 'cancelled' as const,
        changeId: session.changeId,
        sessionId: session.sessionId,
        taskId: session.taskId,
        branch: session.branch,
        baseline: session.baseline,
        mandateBinding,
        changedPaths: Object.freeze([...changedPaths]),
        commitMessage,
        fullGate,
        stateFingerprint: protectedTaskApplyFingerprint({
          phase: 'cancelled',
          transactionId: cancellation.transactionId,
          transactionDigest: cancellation.transaction.recordDigest,
          cancellationRecordDigest: cancellation.recordDigest,
          cancellationReason: cancellation.reason,
          cancelledAt: cancellation.cancelledAt,
          sessionState: session.state,
        }),
        transactionId: cancellation.transactionId,
        commitHash: null,
        authorization: null,
      });
    }
    if (session.state !== 'active') {
      throw protectedTaskApplyAuthorizationInvalid(
        'Protected Apply has no durable finalize transaction for this terminal session.',
      );
    }
    const context = loadActiveSessionContext(cwd, session.sessionId);
    if (
      context.git.head !== session.baseline.head ||
      context.git.branch !== session.branch
    ) {
      throw protectedTaskApplyAuthorizationInvalid(
        'The protected task repository identity changed before Grant creation.',
      );
    }
    const engineOwnedPaths = new Set(
      session.implementationReconciliationPaths ?? [],
    );
    const changedPaths = listChangedPaths(
      context.git.repositoryRoot,
      session.baseline.head,
    ).filter((changedPath) => !engineOwnedPaths.has(changedPath));
    const requirement = resolveTaskAuthorizationRequirementAtBaseline(
      context.git.repositoryRoot,
      session.baseline.head,
      context.config,
      changedPaths,
    );
    if (requirement === null || !requirement.requiresMandate) {
      throw protectedTaskApplyAuthorizationInvalid(
        'The current task diff does not require protected Apply authority.',
      );
    }
    return Object.freeze({
      phase: 'pending' as const,
      changeId: session.changeId,
      sessionId: session.sessionId,
      taskId: session.taskId,
      branch: session.branch,
      baseline: session.baseline,
      mandateBinding,
      changedPaths: Object.freeze([...changedPaths]),
      commitMessage,
      fullGate,
      stateFingerprint: protectedTaskApplyFingerprint({
        phase: 'pending',
        session,
        repositoryFingerprint: fingerprintRepositoryProjection(
          context.git.repositoryRoot,
          session.baseline.head,
          context.git.statusEntries,
        ),
        statusEntries: context.git.statusEntries,
        requirement,
        commitMessage,
        fullGate,
      }),
      transactionId: null,
      commitHash: null,
      authorization: Object.freeze({
        changeId: session.changeId,
        taskId: session.taskId,
        mandateTaskId: mandateBinding.mandateTaskId,
        changedPaths: Object.freeze([...changedPaths]),
        roles: Object.freeze([...requirement.roles]),
        matchedPatterns: Object.freeze([...requirement.matchedPatterns]),
        unclassifiedScope: requirement.unclassifiedScope,
      }),
    });
  }

  assertFinalizeTransactionMatchesSession(transaction, session, git);
  if (transaction.protectedApply === undefined) {
    throw protectedTaskApplyAuthorizationInvalid(
      'The durable finalize transaction has no protected Apply authorization lineage.',
    );
  }
  if (
    expectedParentChallengeId !== undefined &&
    transaction.protectedApply.challengeId !== expectedParentChallengeId
  ) {
    throw protectedTaskApplyAuthorizationInvalid(
      'Protected Apply transaction belongs to another Grant challenge.',
    );
  }
  assertPreparedProtectedTaskApplyAuthorization(
    runtime.root,
    transaction.protectedApply,
    expectedParameters,
  );
  if (expectedParameters !== undefined) {
    assertProtectedApplyAuthorizationMatchesParameters(
      transaction.protectedApply,
      expectedParameters,
    );
  }
  if (transaction.protectedApply.commitMessage !== commitMessage) {
    throw protectedTaskApplyAuthorizationInvalid(
      'The protected Apply commit subject changed after authorization.',
    );
  }
  const changedPaths = finalizeTransactionTaskPaths(transaction, session);
  const completed =
    transaction.phase === 'completed' &&
    session.state === 'committed' &&
    session.commitHash !== undefined &&
    session.commitHash !== null;
  return Object.freeze({
    phase: completed ? ('completed' as const) : ('in-progress' as const),
    changeId: session.changeId,
    sessionId: session.sessionId,
    taskId: session.taskId,
    branch: session.branch,
    baseline: session.baseline,
    mandateBinding,
    changedPaths: Object.freeze([...changedPaths]),
    commitMessage,
    fullGate,
    stateFingerprint: protectedTaskApplyFingerprint({
      phase: completed ? 'completed' : 'in-progress',
      transactionId: transaction.transactionId,
      transactionDigest: transaction.recordDigest,
      transactionPhase: transaction.phase,
      sessionState: session.state,
      commitHash: session.commitHash ?? null,
      commitReportId: session.commitReportId ?? null,
    }),
    transactionId: transaction.transactionId,
    commitHash: completed ? (session.commitHash ?? null) : null,
    authorization: null,
  });
}

export function assertProtectedTaskApplyParametersCurrent(
  cwd: string,
  parameters: ProtectedTaskApplyFinalizationParametersV1,
): void {
  const observed = inspectProtectedTaskApplyLifecycleState(
    cwd,
    parameters.sessionId,
    parameters.commitMessage,
    parameters.fullGate === true,
    parameters,
  );
  assertProtectedTaskApplyParametersMatch(observed, parameters);
}

export function assertProtectedApplyTransactionAuthorization(
  cwd: string,
  session: WorkflowSession,
  authorization: ProtectedTaskApplyAuthorizationBinding,
): FinalizeTransaction {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const transaction = readFinalizeTransaction(runtime.root, session.sessionId);
  if (transaction === null) {
    throw protectedTaskApplyAuthorizationInvalid(
      'Protected Apply finalize transaction is unavailable.',
    );
  }
  assertFinalizeTransactionMatchesSession(transaction, session, git);
  assertPreparedProtectedTaskApplyAuthorization(runtime.root, authorization);
  if (
    transaction.protectedApply === undefined ||
    canonicalJson(transaction.protectedApply) !== canonicalJson(authorization)
  ) {
    throw protectedTaskApplyAuthorizationInvalid(
      'Protected Apply finalize transaction belongs to another Grant operation.',
    );
  }
  return transaction;
}
