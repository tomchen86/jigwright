/**
 * Projects provider lifecycle state from exact durable request, manifest, and runtime evidence.
 *
 * Invariants:
 * - Projection ownership and generations come from validated records and policy snapshots.
 * - Unsafe invocations stay observable instead of silently disappearing from recovery scans.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { inspectProviderInvocationSupersessionRelations } from './provider-invocation-supersession-schema.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
} from '../../foundation/repository-path/repository-path.ts';
import {
  type InvestigationEvidenceRefsClosure,
  readInvestigationEvidenceRefsClosure,
} from './evidence-ref-closure.ts';
import { exactUnsafePathObservationDigest } from './evidence-unsafe-observation.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import { resolvePlanReviewInvocationOwner } from './evidence-plan-review-ownership.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  walkPrivateDirectory,
} from './investigation-private-files.ts';
import {
  deepFreeze,
  hasExactKeys,
  isDigest,
  isRecord,
  isTaskMandateBinding,
  isTimestamp,
  providerInvocationUnsafe,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';
import {
  assertProviderInvocationOutputManifestBinding,
  assertProviderRuntimeDurableAuthorities,
} from './provider-runtime-authority.ts';
import {
  type ProviderInvocationLifecycleProjection,
  type ProviderInvocationLifecycleScan,
  assertProviderExecutionPolicySnapshot,
  assertProviderInvocationRuntimeEvidence,
  isProviderInvocationFailureShape,
  isProviderInvocationLifecycleLease,
} from './provider-runtime-evidence-contract.ts';
import {
  PROVIDER_POLICY_ROOT_FILE,
  digestPrivateDirectoryEntries,
} from './provider-runtime-retention.ts';

export function listProviderInvocationLifecycleProjections(
  paths: InvestigationRuntimePaths,
): ProviderInvocationLifecycleProjection[] {
  const scan = scanProviderInvocationLifecycles(paths);
  const unsafeInvocations = scan.unsafeInvocations.filter(
    ({ invocationId }) =>
      !isDurablyReservedProviderExecutionPolicySnapshot(paths, invocationId),
  );
  if (unsafeInvocations.length > 0) {
    throw providerInvocationUnsafe();
  }
  return [...scan.projections];
}

export function scanProviderInvocationLifecycles(
  paths: InvestigationRuntimePaths,
): ProviderInvocationLifecycleScan {
  const stats = fs.lstatSync(paths.invocations, { throwIfNoEntry: false });
  if (!stats) {
    return deepFreeze({ projections: [], unsafeInvocations: [] });
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !walkPrivateDirectory(
      paths,
      paths.invocations,
      providerInvocationUnsafe,
      false,
    )
  ) {
    throw providerInvocationUnsafe();
  }
  const projections: ProviderInvocationLifecycleProjection[] = [];
  const unsafeInvocations: Array<{
    invocationId: string;
    ownerInvestigationId: string | null;
    observationDigest: string;
  }> = [];
  for (const entry of fs
    .readdirSync(paths.invocations, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw providerInvocationUnsafe();
    }
    const invocationId = assertInvocationId(entry.name);
    try {
      projections.push(
        readProviderInvocationLifecycleProjection(paths, invocationId),
      );
    } catch {
      unsafeInvocations.push({
        invocationId,
        ownerInvestigationId: tryReadPlanReviewInvocationOwnerHint(
          paths,
          invocationId,
        ),
        observationDigest: exactUnsafePathObservationDigest(
          path.join(paths.invocations, invocationId),
          `provider-invocation:${invocationId}`,
        ),
      });
    }
  }
  return deepFreeze({
    projections,
    unsafeInvocations,
  });
}

function tryReadPlanReviewInvocationOwnerHint(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string | null {
  try {
    const directory = path.join(paths.invocations, invocationId);
    const request = recreateProviderInvocationRequest(
      readPrivateCanonicalJson(
        paths,
        path.join(directory, 'request.json'),
        providerInvocationUnsafe,
      ),
    );
    const manifest = readPrivateCanonicalJson(
      paths,
      path.join(directory, 'manifest.json'),
      providerInvocationUnsafe,
    );
    if (
      request.purpose !== 'plan-review' ||
      !isRecord(manifest) ||
      manifest.kind !== 'plan-review-manifest' ||
      typeof manifest.changeId !== 'string'
    ) {
      return null;
    }
    return resolvePlanReviewInvocationOwner(paths, {
      changeId: String(manifest.changeId),
      subject: manifest.subject,
      assignment: request.roleAssignment,
      authorizationNodeId: request.authorizationNodeId,
    });
  } catch {
    return null;
  }
}

export function readProviderInvocationLifecycleProjection(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): ProviderInvocationLifecycleProjection {
  const invocationId = assertInvocationId(requestedInvocationId);
  const directory = path.join(paths.invocations, invocationId);
  const value = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'state.json'),
    providerInvocationUnsafe,
  );
  const requestValue = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'request.json'),
    providerInvocationUnsafe,
  );
  const manifest = readPrivateCanonicalJson(
    paths,
    path.join(directory, 'manifest.json'),
    providerInvocationUnsafe,
  );
  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(requestValue);
  } catch {
    throw providerInvocationUnsafe();
  }
  const policySnapshotPath = path.join(directory, PROVIDER_POLICY_ROOT_FILE);
  if (!privatePathExists(paths, policySnapshotPath, providerInvocationUnsafe)) {
    throw providerInvocationUnsafe();
  }
  assertProviderExecutionPolicySnapshot(
    paths,
    readPrivateCanonicalJson(
      paths,
      policySnapshotPath,
      providerInvocationUnsafe,
    ),
    request,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'invocationId',
      'investigationId',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'attempt',
      'revision',
      'state',
      'providerId',
      'purpose',
      'requestDigest',
      'manifestDigest',
      'leaseGeneration',
      'lease',
      'result',
      'failure',
      ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
        ? ['runtimeReceipt']
        : []),
      'createdAt',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.invocationId !== invocationId ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    (Object.prototype.hasOwnProperty.call(value, 'mandateBinding') &&
      !isTaskMandateBinding(value.mandateBinding, value.changeId)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(
      String(value.state),
    ) ||
    (value.providerId !== 'codex' && value.providerId !== 'claude') ||
    (value.purpose !== 'survey' &&
      value.purpose !== 'plan-review' &&
      value.purpose !== 'task-diff-review' &&
      value.purpose !== 'task-implementation') ||
    !isDigest(value.requestDigest) ||
    !isDigest(value.manifestDigest) ||
    !isProviderInvocationFailureShape(value.failure) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 0 ||
    !isProviderInvocationLifecycleLease(value.lease) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    ![
      'blind-survey-manifest',
      'plan-review-manifest',
      'task-diff-review-manifest',
      'task-diff-review-continuation-manifest',
      'task-strategy-implementation-manifest',
    ].includes(String(manifest.kind)) ||
    (manifest.kind === 'task-strategy-implementation-manifest'
      ? !isRecord(manifest.subject) ||
        manifest.subject.changeId !== value.changeId
      : manifest.changeId !== value.changeId) ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.baseCommit !== request.baseCommit ||
    manifest.baseTree !== request.baseTree ||
    manifest.capabilityProfile !== request.capabilityProfile ||
    request.invocationId !== invocationId ||
    request.requestDigest !== value.requestDigest ||
    request.providerId !== value.providerId ||
    request.purpose !== value.purpose ||
    sha256(canonicalJson(manifest)) !== value.manifestDigest ||
    (value.purpose === 'survey' && manifest.kind !== 'blind-survey-manifest') ||
    (value.purpose === 'plan-review' &&
      manifest.kind !== 'plan-review-manifest') ||
    (value.purpose === 'task-diff-review' &&
      manifest.kind !== 'task-diff-review-manifest' &&
      manifest.kind !== 'task-diff-review-continuation-manifest') ||
    (value.purpose === 'task-implementation' &&
      manifest.kind !== 'task-strategy-implementation-manifest')
  ) {
    throw providerInvocationUnsafe();
  }
  const runtimeEvidence = assertProviderInvocationRuntimeEvidence(
    value,
    request,
    providerInvocationUnsafe,
  );
  assertProviderInvocationOutputManifestBinding(
    runtimeEvidence,
    manifest,
    providerInvocationUnsafe,
  );
  assertProviderRuntimeDurableAuthorities(
    paths,
    request,
    runtimeEvidence,
    runtimeEvidence.result,
    runtimeEvidence.runtimeReceipt,
    providerInvocationUnsafe,
  );
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (
    (value.state === 'prepared' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'leased' &&
      (value.lease === null ||
        value.result !== null ||
        value.failure !== null)) ||
    (value.state === 'succeeded' &&
      (value.lease !== null ||
        value.result === null ||
        value.failure !== null)) ||
    (value.state === 'failed' &&
      (value.lease !== null ||
        value.result !== null ||
        value.failure === null)) ||
    (value.lease !== null && value.lease.generation !== value.leaseGeneration)
  ) {
    throw providerInvocationUnsafe();
  }
  const ownerInvestigationId =
    value.purpose === 'plan-review'
      ? resolvePlanReviewInvocationOwner(paths, {
          changeId: value.changeId,
          subject: manifest.subject,
          assignment: request.roleAssignment,
          authorizationNodeId: request.authorizationNodeId,
        })
      : value.investigationId;
  if (ownerInvestigationId !== value.investigationId) {
    throw providerInvocationUnsafe();
  }
  const supersession = inspectProviderInvocationSupersessionRelations(
    paths,
    invocationId,
    {
      exists: (filePath) =>
        privatePathExists(paths, filePath, providerInvocationUnsafe),
      read: (filePath) =>
        readPrivateCanonicalJson(paths, filePath, providerInvocationUnsafe),
    },
  );
  const replacementSnapshot = supersession.replacementOf?.supersededBy;
  const supersededSnapshot = supersession.supersededBy?.replacementOf;
  for (const snapshot of [replacementSnapshot, supersededSnapshot]) {
    if (
      snapshot !== undefined &&
      (snapshot.invocationId !== invocationId ||
        snapshot.attempt !== value.attempt ||
        snapshot.requestDigest !== request.requestDigest ||
        snapshot.manifestDigest !== value.manifestDigest ||
        snapshot.subjectDigest !== request.targetDigest ||
        snapshot.createdAt !== value.createdAt)
    ) {
      throw providerInvocationUnsafe();
    }
  }
  if (
    supersededSnapshot !== undefined &&
    (value.state !== 'failed' ||
      supersededSnapshot.terminalStatus !== 'failed' ||
      supersededSnapshot.terminalAt !== value.updatedAt ||
      supersededSnapshot.failureCode !==
        (isRecord(value.failure) ? value.failure.code : null) ||
      supersededSnapshot.invocationRevision !== value.revision)
  ) {
    throw providerInvocationUnsafe();
  }
  // Validate the exact private invocation closure here as well as when a
  // human-resolution digest is projected. Callers that only enumerate
  // lifecycle projections must not silently accept malformed authority files.
  // A file the engine does not own is reported rather than fatal: reading is
  // how an operator finds out it is there.
  let strayFiles: readonly string[] = [];
  digestPrivateDirectoryEntries(paths, directory, providerInvocationUnsafe, {
    admitStray: (names) => {
      strayFiles = names;
    },
  });
  return deepFreeze({
    invocationId,
    investigationId: value.investigationId,
    ownerInvestigationId,
    changeId: value.changeId,
    purpose: value.purpose,
    attempt: value.attempt,
    revision: value.revision,
    state: value.state,
    policySnapshot: 'recorded',
    requestDigest: value.requestDigest,
    manifestDigest: value.manifestDigest,
    nonce: request.nonce,
    failureKind: value.failure === null ? null : value.failure.kind,
    leaseGeneration: value.leaseGeneration,
    lease:
      value.lease === null
        ? null
        : {
            generation: value.lease.generation,
            workerId: value.lease.workerId,
            tokenDigest: value.lease.tokenDigest,
            acquiredAt: value.lease.acquiredAt,
            expiresAt: value.lease.expiresAt,
          },
    strayFiles,
  } as ProviderInvocationLifecycleProjection);
}

export function isDurablyReservedProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): boolean {
  const directory = path.join(paths.invocations, invocationId);
  try {
    if (
      canonicalJson(fs.readdirSync(directory).sort()) !==
      canonicalJson(['execution-policy.json'])
    ) {
      return false;
    }
    for (const name of fs.readdirSync(paths.refs).sort()) {
      if (
        !name.endsWith('.investigation-start.json') &&
        !/\.provider-retry-[1-9][0-9]*\.json$/.test(name)
      ) {
        continue;
      }
      const value = readPrivateCanonicalJson(
        paths,
        path.join(paths.refs, name),
        providerInvocationUnsafe,
      );
      if (!isRecord(value) || !isRecord(value.request)) {
        continue;
      }
      const retryV2 =
        value.kind === 'provider-retry-reservation' &&
        value.schemaVersion === 2;
      const expectedKeys =
        value.kind === 'investigation-start-reservation' &&
        value.schemaVersion === 1
          ? [
              'baseline',
              'branch',
              'changeId',
              'createdAt',
              'gitCommonDirectory',
              'investigationId',
              'invocationId',
              'kind',
              ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
              'manifest',
              'manifestDigest',
              'repositoryRoot',
              'request',
              'requestDigest',
              'schemaVersion',
            ]
          : retryV2
            ? [
                'attempt',
                'changeId',
                'createdAt',
                'investigationId',
                'invocationId',
                'kind',
                'manifestDigest',
                ...(Object.prototype.hasOwnProperty.call(
                  value,
                  'mandateBinding',
                )
                  ? ['mandateBinding']
                  : []),
                'previousInvocationId',
                'request',
                'requestDigest',
                'schemaVersion',
                'executionPolicySnapshot',
                'retryDecision',
              ]
            : null;
      if (
        expectedKeys === null ||
        !hasExactKeys(value, expectedKeys) ||
        value.invocationId !== invocationId
      ) {
        continue;
      }
      const request = recreateProviderInvocationRequest(value.request);
      if (
        request.invocationId !== invocationId ||
        request.requestDigest !== value.requestDigest
      ) {
        continue;
      }
      const storedSnapshot = readPrivateCanonicalJson(
        paths,
        path.join(directory, 'execution-policy.json'),
        providerInvocationUnsafe,
      );
      assertProviderExecutionPolicySnapshot(paths, storedSnapshot, request);
      if (retryV2) {
        assertProviderExecutionPolicySnapshot(
          paths,
          value.executionPolicySnapshot,
          request,
        );
        if (
          canonicalJson(storedSnapshot) !==
          canonicalJson(value.executionPolicySnapshot)
        ) {
          continue;
        }
      }
      return true;
    }
    for (const name of fs.readdirSync(paths.refs).sort()) {
      if (!name.endsWith('.json')) continue;
      const changeId = name.slice(0, -'.json'.length);
      let closure: InvestigationEvidenceRefsClosure;
      try {
        assertChangeId(changeId);
        closure = readInvestigationEvidenceRefsClosure(paths, changeId);
      } catch {
        continue;
      }
      const refs = closure.snapshot.refs;
      if (refs === null) continue;
      const nodeId = refs['propose/plan-review-request'];
      if (nodeId === undefined) continue;
      const node = readEvidenceNode(paths, nodeId);
      const output = node.output;
      const retryShape = isRecord(output) && output.retry !== null;
      const closureEntries = closure.entries.filter(
        (entry) => entry.refName === 'propose/plan-review-request',
      );
      if (
        node.type !== 'plan-review-request-reservation' ||
        node.nodeSchema !== 'workflow.plan-review-request-reservation.v3' ||
        node.evaluator !== 'workflow-propose.v1' ||
        node.policyDigest !== PROPOSE_POLICY_DIGEST ||
        node.outputSchema !==
          'workflow.plan-review-request-reservation-output.v3' ||
        !isRecord(output) ||
        !hasExactKeys(output, [
          'investigationId',
          'changeId',
          'planning',
          'subject',
          'assignment',
          'author',
          'materializationNode',
          'targetSnapshotNode',
          'manifest',
          'request',
          'grantAuthorization',
          'retry',
        ]) ||
        !hasExactKeys(node.exactInputDigests, [
          'manifest',
          'request',
          'subject',
          'targetSnapshot',
          ...(retryShape ? ['previousRequest', 'failure'] : []),
          ...(retryShape ? ['executionPolicySnapshot', 'retryDecision'] : []),
        ]) ||
        !hasExactKeys(node.provenanceParentNodeIds, [
          'authorization',
          ...(retryShape ? ['previousRequest'] : []),
        ]) ||
        !hasExactKeys(node.semanticParentResultDigests, [
          'authorization',
          ...(retryShape ? ['previousRequest'] : []),
        ]) ||
        output.changeId !== changeId ||
        closureEntries.length !== 1 ||
        closureEntries[0]?.nodeId !== nodeId ||
        closureEntries[0]?.ownerInvestigationId !== output.investigationId ||
        !isRecord(output.request)
      ) {
        continue;
      }
      const request = recreateProviderInvocationRequest(output.request);
      if (
        request.invocationId !== invocationId ||
        request.requestDigest !== node.exactInputDigests.request ||
        request.authorizationNodeId !==
          node.provenanceParentNodeIds.authorization
      ) {
        continue;
      }
      const storedSnapshot = readPrivateCanonicalJson(
        paths,
        path.join(directory, 'execution-policy.json'),
        providerInvocationUnsafe,
      );
      assertProviderExecutionPolicySnapshot(paths, storedSnapshot, request);
      if (output.retry === null) {
        // Initial PlanReview publication stores policy before creating the
        // invocation. A V3 reservation with retry:null is its sole durable
        // recovery authority for that policy-only crash window. The exact
        // current refs closure above proves that this is not an orphan or a
        // rebound V3-labeled object.
        return true;
      }
      if (
        !isRecord(output.retry) ||
        !isRecord(output.retry.executionPolicySnapshot)
      ) {
        continue;
      }
      assertProviderExecutionPolicySnapshot(
        paths,
        output.retry.executionPolicySnapshot,
        request,
      );
      if (
        canonicalJson(storedSnapshot) !==
        canonicalJson(output.retry.executionPolicySnapshot)
      ) {
        continue;
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
