import { taskMandateOperations } from './task-mandate-production.ts';
/**
 * Connects protected-task Grant observation and finalization to production
 * lifecycle operations.
 *
 * Invariants:
 * - Finalization asserts lifecycle ownership and checks the active mandate
 *   unless the task is already completed.
 */
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { inspectProtectedTaskApplyLifecycleState } from '../application/finalize/lifecycle.ts';
import type { ProtectedTaskApplyFinalizer } from './finalization-production.ts';

import {
  type ProtectedTaskApplyFinalizationParametersV1,
  type ProtectedTaskApplyGrantPort,
  type ProtectedTaskApplyObservationV1,
} from '../modules/authority/protected-task-apply-grant.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';

export function observeCurrentProtectedTaskApply(
  cwd: string,
  sessionId: string,
  commitMessage: string,
  fullGate: boolean,
  expectedParameters?: ProtectedTaskApplyFinalizationParametersV1,
  expectedParentChallengeId?: string,
): ProtectedTaskApplyObservationV1 {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observed = inspectProtectedTaskApplyLifecycleState(
    repositoryRoot,
    sessionId,
    commitMessage,
    fullGate,
    expectedParameters,
    expectedParentChallengeId,
  );
  const repositoryId = repositoryIdAtBaseline(
    repositoryRoot,
    observed.baseline.head,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-task-apply-observation.v1',
    ...observed,
    repositoryId,
  });
}

export function createProductionProtectedTaskApplyGrantPort(
  finalizeProtectedTaskApplyUnderGrant: ProtectedTaskApplyFinalizer,
  cwd: string,
): ProtectedTaskApplyGrantPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return Object.freeze({
    observe(
      parameters: ProtectedTaskApplyFinalizationParametersV1,
      parentChallengeId?: string,
    ) {
      const observed = observeCurrentProtectedTaskApply(
        repositoryRoot,
        parameters.sessionId,
        parameters.commitMessage,
        parameters.fullGate === true,
        parameters,
        parentChallengeId,
      );
      if (observed.repositoryId !== parameters.repositoryId) {
        throw workflowError(
          'PROTECTED_TASK_APPLY_REPOSITORY_CHANGED',
          'The repository identity changed before protected Apply execution.',
          ExitCode.staleState,
        );
      }
      return observed;
    },
    finalize(context) {
      context.assertLifecycleOwned();
      const before = observeCurrentProtectedTaskApply(
        repositoryRoot,
        context.parameters.sessionId,
        context.parameters.commitMessage,
        context.parameters.fullGate === true,
        context.parameters,
      );
      if (before.phase !== 'completed') {
        assertActiveTaskMandateBindingUnderLifecycleLock(
          repositoryRoot,
          context.parameters.mandateBinding,
          context.assertLifecycleOwned,
        );
      }
      context.assertLifecycleOwned();
      const result = finalizeProtectedTaskApplyUnderGrant(
        repositoryRoot,
        context.parameters,
        Object.freeze({
          schemaVersion: 1 as const,
          kind: 'protected-task-apply-authorization.v1' as const,
          transitionId: 'task.protected-apply.finalize.v1' as const,
          challengeId: context.challengeId,
          operationId: context.operationId,
          approvalSubjectDigest: context.approvalSubjectDigest,
          stateBindingDigest: context.parameters.stateBindingDigest,
          parametersDigest: grantSha256(canonicalJson(context.parameters)),
          commitMessage: context.parameters.commitMessage,
        }),
        context.assertLifecycleOwned,
      );
      context.assertLifecycleOwned();
      return Object.freeze({
        sessionId: result.session.sessionId,
        transactionId: result.transactionId,
        commitHash: result.commitHash,
      });
    },
  });
}

function repositoryIdAtBaseline(
  repositoryRoot: string,
  baselineHead: string,
): string {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${baselineHead}:workflow/maintainer-policy.json`,
      ]),
    );
  } catch {
    throw workflowError(
      'PROTECTED_TASK_APPLY_POLICY_UNAVAILABLE',
      'The baseline maintainer policy is unavailable for protected Apply.',
      ExitCode.guard,
    );
  }
  return parseMaintainerPolicy(value).repository.id;
}

const { assertActiveTaskMandateBindingUnderLifecycleLock } =
  taskMandateOperations;
