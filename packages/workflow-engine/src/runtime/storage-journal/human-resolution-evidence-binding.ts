/**
 * Checks materialization ownership and start-reservation evidence for resolution targets.
 *
 * Invariants:
 * - Materializations retain exact owner-session, manifest, checkpoint, and mandate bindings.
 * - Start reservations preserve their current schema and digest validation.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  PROPOSE_POLICY_DIGEST,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import type { InvestigationEvidenceRefsClosure } from './evidence-ref-closure.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import {
  MAX_HUMAN_RESOLUTION_BYTES,
  privatePathExists,
  readPrivateCanonicalJson,
  readPrivateFile,
} from '../journal-primitives/investigation-private-files.ts';
import {
  humanResolutionStateInvalid,
  investigationStartReservationPath,
} from '../journal-primitives/investigation-resolution-values.ts';
import {
  isBoundedResolutionText,
  isEmptyRecord,
} from '../../modules/investigation/domain/human-resolution-values.ts';
import { readInvestigationSession } from './investigation-session-records.ts';
import type { InvestigationSession } from '../../modules/investigation/domain/investigation-session-types.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  isTimestamp,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';
import {
  isProposeExemptionInvestigationId,
  readProposeExemptionSession,
} from './propose-exemption-store.ts';
import type { ProposeExemptionSession } from '../../modules/lifecycle/propose-exemption-session.ts';
export function assertEvidenceClosureTargetBinding(
  paths: InvestigationRuntimePaths,
  targetSession: InvestigationSession,
  closure: InvestigationEvidenceRefsClosure,
): void {
  for (const entry of closure.entries) {
    const owner = isProposeExemptionInvestigationId(entry.ownerInvestigationId)
      ? readProposeExemptionSession(paths, entry.ownerInvestigationId)
      : readInvestigationSession(paths, entry.ownerInvestigationId);
    if (owner.changeId !== targetSession.changeId) {
      throw humanResolutionStateInvalid();
    }
    if (entry.refName === 'propose/exemption-session') {
      if (
        !('kind' in owner) ||
        owner.kind !== 'propose-exemption-session' ||
        owner.investigationId !== entry.ownerInvestigationId
      ) {
        throw humanResolutionStateInvalid();
      }
      continue;
    }
    if (entry.refName === 'propose/planning-materialization') {
      assertMaterializationMatchesOwnerSession(
        paths,
        readEvidenceNode(paths, entry.nodeId),
        owner,
      );
      continue;
    }
    if (entry.refName === 'propose/plan-review-request') {
      const materialization = entry.dependencies.find(
        (dependency) => dependency.role === 'materialization',
      );
      if (!materialization) {
        throw humanResolutionStateInvalid();
      }
      assertMaterializationMatchesOwnerSession(
        paths,
        readEvidenceNode(paths, materialization.nodeId),
        owner,
      );
      continue;
    }
    if (entry.refName === 'propose/plan-review-grant-requirement') {
      const node = readEvidenceNode(paths, entry.nodeId);
      const output = node.output;
      if (
        !isRecord(output) ||
        !isRecord(output.requirement) ||
        !isRecord(output.requirement.subject) ||
        !isRecord(output.requirement.subject.investigationBaseline) ||
        canonicalJson(output.requirement.subject.investigationBaseline) !==
          canonicalJson(owner.baseline)
      ) {
        throw humanResolutionStateInvalid();
      }
      continue;
    }
    throw humanResolutionStateInvalid();
  }
}

function assertMaterializationMatchesOwnerSession(
  paths: InvestigationRuntimePaths,
  node: ReturnType<typeof readEvidenceNode>,
  session: InvestigationSession | ProposeExemptionSession,
): void {
  const output = node.output;
  if (!('kind' in session)) {
    assertManifestMaterializationMatchesOwnerSession(paths, node, session);
    return;
  }
  const revisionMatches =
    isRecord(output) && output.revision === session.revision;
  if (
    node.type !== 'propose-exemption-planning-materialization' ||
    !isRecord(output) ||
    output.investigationId !== session.investigationId ||
    output.changeId !== session.changeId ||
    !revisionMatches ||
    !isRecord(output.baseline) ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    output.applicabilityNodeId !== session.applicabilityNode.nodeId ||
    output.applicabilityResultDigest !== session.applicabilityNode.resultDigest
  ) {
    throw humanResolutionStateInvalid();
  }
}

function assertManifestMaterializationMatchesOwnerSession(
  paths: InvestigationRuntimePaths,
  node: ReturnType<typeof readEvidenceNode>,
  session: InvestigationSession,
): void {
  const output = node.output;
  if (
    node.type !== 'propose-planning-materialization' ||
    node.nodeSchema !== 'workflow.propose-planning-materialization.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-planning-materialization-output.v3' ||
    !hasExactKeys(node.exactInputDigests, [
      'artifacts',
      'baseline',
      'manifestAuthority',
      'manifest',
      'investigationTarget',
      'sessionSnapshot',
    ]) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['manifestAuthority']) ||
    !hasExactKeys(node.semanticParentResultDigests, ['manifestAuthority']) ||
    !isEmptyRecord(node.runtimeMetadata) ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'semanticRevision',
      'baseline',
      'artifacts',
      'manifestAuthorityNodeId',
      'manifestAuthorityResultDigest',
      'manifestDigest',
      'investigationTargetDigest',
      'sessionSnapshotDigest',
    ]) ||
    output.investigationId !== session.investigationId ||
    output.changeId !== session.changeId ||
    output.semanticRevision !== session.semanticRevision ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    !isMaterializationDigestRecord(output.artifacts) ||
    !isDigest(output.manifestAuthorityNodeId) ||
    !isDigest(output.manifestAuthorityResultDigest) ||
    !isDigest(output.manifestDigest) ||
    !isDigest(output.investigationTargetDigest) ||
    !isDigest(output.sessionSnapshotDigest) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(session.baseline)) ||
    node.exactInputDigests.manifestAuthority !==
      output.manifestAuthorityNodeId ||
    node.exactInputDigests.manifest !== output.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      output.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !== output.sessionSnapshotDigest ||
    node.provenanceParentNodeIds.manifestAuthority !==
      output.manifestAuthorityNodeId ||
    node.semanticParentResultDigests.manifestAuthority !==
      output.manifestAuthorityResultDigest
  ) {
    throw humanResolutionStateInvalid();
  }

  let authorityNode: ReturnType<typeof readEvidenceNode>;
  try {
    authorityNode = readEvidenceNode(paths, output.manifestAuthorityNodeId);
  } catch {
    throw humanResolutionStateInvalid();
  }
  const authority = authorityNode.output;
  if (
    authorityNode.nodeId !== output.manifestAuthorityNodeId ||
    authorityNode.resultDigest !== output.manifestAuthorityResultDigest ||
    authorityNode.type !== 'investigation-manifest-authority' ||
    authorityNode.nodeSchema !== 'investigation.manifest-authority.v1' ||
    authorityNode.evaluator !== 'workflow-propose.manifest-authority.v1' ||
    authorityNode.policyDigest !== PROPOSE_POLICY_DIGEST ||
    authorityNode.outputSchema !==
      'investigation.manifest-authority-output.v1' ||
    !hasExactKeys(authorityNode.exactInputDigests, [
      'manifest',
      'investigationTarget',
      'sessionSnapshot',
    ]) ||
    !isEmptyRecord(authorityNode.provenanceParentNodeIds) ||
    !isEmptyRecord(authorityNode.semanticParentResultDigests) ||
    !isEmptyRecord(authorityNode.runtimeMetadata) ||
    !isRecord(authority) ||
    !hasExactKeys(authority, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'manifestDigest',
      'investigationTargetDigest',
    ]) ||
    !isBoundedResolutionText(authority.repositoryId, 256) ||
    authority.changeId !== session.changeId ||
    authority.investigationId !== session.investigationId ||
    !Number.isSafeInteger(authority.sessionRevision) ||
    Number(authority.sessionRevision) < session.semanticRevision ||
    Number(authority.sessionRevision) > session.revision ||
    authority.sessionSnapshotDigest !== output.sessionSnapshotDigest ||
    authority.manifestDigest !== output.manifestDigest ||
    authority.investigationTargetDigest !== output.investigationTargetDigest ||
    authorityNode.exactInputDigests.manifest !== output.manifestDigest ||
    authorityNode.exactInputDigests.investigationTarget !==
      output.investigationTargetDigest ||
    authorityNode.exactInputDigests.sessionSnapshot !==
      output.sessionSnapshotDigest
  ) {
    throw humanResolutionStateInvalid();
  }
}

function isMaterializationDigestRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([relativePath, digest]) => relativePath.length > 0 && isDigest(digest),
    )
  );
}

export function digestBoundStartReservation(
  paths: InvestigationRuntimePaths,
  session: InvestigationSession,
  makeError: () => WorkflowError,
): string | null {
  const filePath = investigationStartReservationPath(paths, session.changeId);
  if (!privatePathExists(paths, filePath, makeError)) {
    return null;
  }
  const content = readPrivateFile(filePath, makeError);
  if (Buffer.byteLength(content, 'utf8') > MAX_HUMAN_RESOLUTION_BYTES) {
    throw makeError();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw makeError();
  }
  if (
    content !== `${canonicalJson(value)}\n` ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
        ? ['mandateBinding']
        : []),
      'investigationId',
      'invocationId',
      'repositoryRoot',
      'gitCommonDirectory',
      'branch',
      'baseline',
      'manifestDigest',
      'requestDigest',
      'manifest',
      'request',
      'createdAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-start-reservation' ||
    value.changeId !== session.changeId ||
    canonicalJson(value.mandateBinding ?? null) !==
      canonicalJson(session.mandateBinding ?? null) ||
    value.investigationId !== session.investigationId ||
    value.invocationId !== session.blindInvocationIds[0] ||
    value.repositoryRoot !== session.repositoryRoot ||
    value.gitCommonDirectory !== session.gitCommonDirectory ||
    value.branch !== session.branch ||
    !isRecord(value.baseline) ||
    canonicalJson(value.baseline) !== canonicalJson(session.baseline) ||
    value.manifestDigest !== session.blindManifestDigest ||
    !isTimestamp(value.createdAt)
  ) {
    throw makeError();
  }
  if (
    !isRecord(value.manifest) ||
    sha256(canonicalJson(value.manifest)) !== value.manifestDigest
  ) {
    throw makeError();
  }
  let request: ProviderInvocationRequest;
  let firstInvocationRequest: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(value.request);
    firstInvocationRequest = recreateProviderInvocationRequest(
      readPrivateCanonicalJson(
        paths,
        path.join(
          paths.invocations,
          session.blindInvocationIds[0] as string,
          'request.json',
        ),
        makeError,
      ),
    );
  } catch {
    throw makeError();
  }
  if (
    request.requestDigest !== value.requestDigest ||
    firstInvocationRequest.requestDigest !== request.requestDigest ||
    firstInvocationRequest.invocationId !== request.invocationId ||
    request.invocationId !== value.invocationId ||
    request.purpose !== 'survey' ||
    request.inputManifestDigest !== value.manifestDigest ||
    request.baseCommit !== value.baseline.head ||
    request.baseTree !== value.baseline.tree ||
    value.manifest.changeId !== value.changeId ||
    value.manifest.baseCommit !== value.baseline.head ||
    value.manifest.baseTree !== value.baseline.tree
  ) {
    throw makeError();
  }
  return sha256(content);
}
