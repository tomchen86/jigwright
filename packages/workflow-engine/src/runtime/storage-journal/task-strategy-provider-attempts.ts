/**
 * Reconstructs task implementation transport attempts from durable retry reservations.
 *
 * Invariants:
 * - Retries retain the root semantic subject and exact predecessor invocation chain.
 * - Attempt selection and retry schema checks preserve existing rejection and replay order.
 */
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertInvocationId } from '../../foundation/repository-path/repository-path.ts';
import {
  readProviderInvocation,
  readProviderInvocationEvidence,
} from './provider-invocation-state.ts';
import { readProviderRetryReservation } from './provider-invocation-reservations.ts';
import {
  providerInvocationExists,
  readProviderInvocationRequest,
} from './provider-invocation-artifacts.ts';
import { providerInvocationManifestDigest } from './provider-invocation-manifest-validation.ts';
import type {
  ProviderRetryReservationV2,
  ProviderRetryReservationV3,
} from '../../modules/provider-orchestration/provider-invocation-reservations.ts';
import type {
  TaskStrategyImplementationReservation,
  TaskStrategyImplementationProviderAttempt,
} from '../../modules/assurance/task-strategy-implementation-record.ts';
import {
  stateCorrupt,
  deepFreeze,
  sha256,
} from '../../modules/assurance/task-strategy-implementation-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  resolveTaskStrategyImplementationInvocationOwner,
  readEvidenceNode,
} from './evidence-object-store.ts';
import { TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST } from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';

export function readTaskStrategyImplementationProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
  requestedInvocationId: string,
): TaskStrategyImplementationProviderAttempt {
  const invocationId = assertInvocationId(requestedInvocationId);
  if (invocationId === root.request.invocationId) {
    return rootProviderAttempt(root);
  }
  const invocation = readProviderInvocation(paths, invocationId);
  const retry = readProviderRetryReservation(
    paths,
    root.ownerInvestigationId,
    invocation.attempt,
  );
  if (
    retry === null ||
    (retry.schemaVersion !== 2 && retry.schemaVersion !== 3)
  ) {
    throw stateCorrupt();
  }
  return retryProviderAttempt(paths, root, retry);
}

export function readCurrentTaskStrategyImplementationProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
): TaskStrategyImplementationProviderAttempt {
  let current = rootProviderAttempt(root);
  if (!providerInvocationExists(paths, current.request.invocationId)) {
    return current;
  }
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current.request.invocationId)) throw stateCorrupt();
    visited.add(current.request.invocationId);
    const evidence = readProviderInvocationEvidence(
      paths,
      current.request.invocationId,
    );
    const successor = evidence.supersededBy?.invocation.invocationId ?? null;
    if (successor === null) {
      const reserved = readProviderRetryReservation(
        paths,
        root.ownerInvestigationId,
        current.attempt + 1,
      );
      return reserved === null
        ? current
        : retryProviderAttempt(
            paths,
            root,
            requireRetryReservationV2(reserved),
          );
    }
    current = readTaskStrategyImplementationProviderAttempt(
      paths,
      root,
      successor,
    );
  }
}

export {
  taskStrategyImplementationReservationForAttempt,
  taskStrategyImplementationProviderAttemptReservationDigest,
} from '../../modules/assurance/task-strategy-implementation-attempt.ts';

function rootProviderAttempt(
  root: TaskStrategyImplementationReservation,
): TaskStrategyImplementationProviderAttempt {
  return deepFreeze({
    root,
    attempt: 1,
    previousInvocationId: null,
    assignment: root.assignment,
    manifestDigest: providerInvocationManifestDigest(root.manifest),
    request: root.request,
    authorizationNodeId: root.authorizationNodeId,
    reservationNodeId: root.reservationNodeId,
    retryDecision: null,
    retryReservation: null,
    createdAt: root.createdAt,
  });
}

function retryProviderAttempt(
  paths: InvestigationRuntimePaths,
  root: TaskStrategyImplementationReservation,
  retry: ProviderRetryReservationV2 | ProviderRetryReservationV3,
): TaskStrategyImplementationProviderAttempt {
  const previous = readProviderInvocation(paths, retry.previousInvocationId);
  const previousRequest = readProviderInvocationRequest(
    paths,
    previous.invocationId,
  );
  const retryAuthority =
    retry.schemaVersion === 3
      ? resolveTaskStrategyImplementationInvocationOwner(paths, {
          changeId: root.changeId,
          sessionId: root.sessionId,
          subject: root.subject,
          assignment: retry.request.roleAssignment,
          authorizationNodeId: retry.replacement.authorizationNodeId,
        })
      : null;
  const replacement = retry.schemaVersion === 3 ? retry.replacement : null;
  const requestReservation =
    replacement !== null
      ? readEvidenceNode(paths, replacement.reservationNodeId)
      : null;
  if (
    retry.investigationId !== root.ownerInvestigationId ||
    retry.changeId !== root.changeId ||
    canonicalJson(retry.mandateBinding ?? null) !==
      canonicalJson(root.mandateBinding) ||
    retry.manifestDigest !== providerInvocationManifestDigest(root.manifest) ||
    retry.request.inputManifestDigest !== retry.manifestDigest ||
    retry.request.targetDigest !== root.subject.subjectDigest ||
    retry.request.authorizationNodeId !==
      (retry.schemaVersion === 3
        ? retry.replacement.authorizationNodeId
        : root.authorizationNodeId) ||
    retry.request.invocationId !== retry.invocationId ||
    retry.request.requestDigest !== retry.requestDigest ||
    (retry.schemaVersion === 2 &&
      canonicalJson(retry.request.roleAssignment) !==
        canonicalJson(root.assignment)) ||
    (retryAuthority !== null &&
      (retryAuthority.ownerInvestigationId !== root.ownerInvestigationId ||
        retryAuthority.sessionId !== root.sessionId ||
        canonicalJson(retryAuthority.mandateBinding) !==
          canonicalJson(root.mandateBinding))) ||
    (requestReservation !== null &&
      (requestReservation.type !==
        'task-strategy-implementation-request-reservation' ||
        requestReservation.nodeSchema !==
          'workflow.task-strategy-implementation-reservation.v1' ||
        requestReservation.evaluator !== 'workflow-task-strategy.v1' ||
        requestReservation.policyDigest !==
          TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST ||
        requestReservation.exactInputDigests.request !==
          retry.request.requestDigest ||
        requestReservation.exactInputDigests.manifest !==
          retry.manifestDigest ||
        requestReservation.exactInputDigests.subject !==
          root.subject.subjectDigest ||
        requestReservation.provenanceParentNodeIds.authorization !==
          replacement?.authorizationNodeId ||
        canonicalJson(
          (requestReservation.output as { request?: unknown }).request,
        ) !== canonicalJson(retry.request))) ||
    previous.investigationId !== root.ownerInvestigationId ||
    previous.changeId !== root.changeId ||
    previous.attempt !== retry.attempt - 1 ||
    previous.state !== 'failed' ||
    previous.failure === null ||
    previousRequest.invocationId === retry.request.invocationId ||
    previousRequest.nonce === retry.request.nonce
  ) {
    throw stateCorrupt();
  }
  return deepFreeze({
    root,
    attempt: retry.attempt,
    previousInvocationId: retry.previousInvocationId,
    assignment: retry.request.roleAssignment,
    manifestDigest: retry.manifestDigest,
    request: retry.request,
    authorizationNodeId: retry.request.authorizationNodeId,
    reservationNodeId:
      replacement !== null
        ? replacement.reservationNodeId
        : root.reservationNodeId,
    retryDecision: retry.retryDecision,
    retryReservation: retry,
    createdAt: retry.createdAt,
  });
}

function requireRetryReservationV2(
  value: ReturnType<typeof readProviderRetryReservation>,
): ProviderRetryReservationV2 | ProviderRetryReservationV3 {
  if (
    value === null ||
    (value.schemaVersion !== 2 && value.schemaVersion !== 3)
  ) {
    throw stateCorrupt();
  }
  return value;
}
