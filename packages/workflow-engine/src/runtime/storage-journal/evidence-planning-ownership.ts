/**
 * Validates planning materialization and exemption evidence ownership dependencies.
 *
 * Invariants:
 * - Owner, mandate, manifest, and applicability bindings match the exact recorded evidence.
 * - Dependency closure entries preserve their canonical node and result digests.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type EvidenceNode,
  canonicalEvidenceNodeEnvelope,
} from '../../foundation/evidence-node/evidence-node.ts';
import {
  assertInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
} from '../../modules/investigation/domain/investigation-applicability.ts';
import {
  PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST,
  PROPOSE_POLICY_DIGEST,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import { type InvestigationEvidenceDependencyClosureEntry } from './evidence-ref-closure.ts';
import {
  hasExactKeys,
  isBaseline,
  isDigest,
  isDigestRecord,
  isInvestigationOwner,
  isPlainRecord,
  refInvalid,
  sha256,
} from './evidence-store-values.ts';

export type InvestigationEvidenceOwnership = Readonly<{
  ownerInvestigationId: string;
  dependencies: readonly InvestigationEvidenceDependencyClosureEntry[];
}>;

export function assertPlanningMaterializationOwnership(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  if (!isPlainRecord(output)) {
    throw refInvalid();
  }
  if (node.type === 'propose-planning-materialization') {
    if (
      node.nodeSchema !== 'workflow.propose-planning-materialization.v3' ||
      node.outputSchema !==
        'workflow.propose-planning-materialization-output.v3'
    ) {
      throw refInvalid();
    }
    assertProposeEvidenceNode(node, {
      type: 'propose-planning-materialization',
      nodeSchema: node.nodeSchema,
      outputSchema: node.outputSchema,
      exactInputKeys: [
        'artifacts',
        'baseline',
        'manifestAuthority',
        'manifest',
        'investigationTarget',
        'sessionSnapshot',
      ],
      provenanceKeys: ['manifestAuthority'],
      semanticKeys: ['manifestAuthority'],
    });
    if (
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
      output.changeId !== expectedChangeId ||
      !isInvestigationOwner(output.investigationId) ||
      !Number.isSafeInteger(output.semanticRevision) ||
      Number(output.semanticRevision) < 0 ||
      !isBaseline(output.baseline) ||
      !isDigestRecord(output.artifacts) ||
      !isDigest(output.manifestAuthorityNodeId) ||
      !isDigest(output.manifestAuthorityResultDigest) ||
      !isDigest(output.manifestDigest) ||
      !isDigest(output.investigationTargetDigest) ||
      !isDigest(output.sessionSnapshotDigest) ||
      node.exactInputDigests.artifacts !==
        sha256(canonicalJson(output.artifacts)) ||
      node.exactInputDigests.baseline !==
        sha256(canonicalJson(output.baseline)) ||
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
      throw refInvalid();
    }
    const authority = readManifestAuthorityDependency(
      paths,
      output.manifestAuthorityNodeId,
      output.manifestAuthorityResultDigest,
      {
        changeId: output.changeId,
        investigationId: output.investigationId,
        manifestDigest: output.manifestDigest,
        investigationTargetDigest: output.investigationTargetDigest,
        sessionSnapshotDigest: output.sessionSnapshotDigest,
      },
    );
    return Object.freeze({
      ownerInvestigationId: output.investigationId,
      dependencies: Object.freeze([authority]),
    });
  }

  assertProposeEvidenceNode(node, {
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'workflow.propose-exemption-planning-materialization.v1',
    outputSchema:
      'workflow.propose-exemption-planning-materialization-output.v1',
    exactInputKeys: ['applicability', 'artifacts', 'baseline'],
    provenanceKeys: ['applicability'],
    semanticKeys: ['applicability'],
  });
  if (
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'revision',
      'baseline',
      'artifacts',
      'applicabilityNodeId',
      'applicabilityResultDigest',
    ]) ||
    output.changeId !== expectedChangeId ||
    !isInvestigationOwner(output.investigationId) ||
    !Number.isSafeInteger(output.revision) ||
    (output.revision as number) < 0 ||
    !isBaseline(output.baseline) ||
    !isDigestRecord(output.artifacts) ||
    !isDigest(output.applicabilityNodeId) ||
    !isDigest(output.applicabilityResultDigest) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    node.exactInputDigests.applicability !== output.applicabilityNodeId ||
    node.provenanceParentNodeIds.applicability !== output.applicabilityNodeId ||
    node.semanticParentResultDigests.applicability !==
      output.applicabilityResultDigest
  ) {
    throw refInvalid();
  }
  const applicability = readApplicabilityDependency(
    paths,
    output.applicabilityNodeId,
    output.applicabilityResultDigest,
  );
  return Object.freeze({
    ownerInvestigationId: output.investigationId,
    dependencies: Object.freeze([applicability]),
  });
}

export function assertExemptionSessionOwnership(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  const output = node.output;
  if (
    node.type !== 'propose-exemption-session-reservation' ||
    node.nodeSchema !== 'workflow.propose-exemption-session-reservation.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-exemption-session-reservation-output.v1' ||
    !hasExactKeys(node.exactInputDigests, ['record', 'request']) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['applicability']) ||
    !hasExactKeys(node.semanticParentResultDigests, ['applicability']) ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'changeId',
      'investigationId',
      'recordId',
      'requestDigest',
    ]) ||
    output.changeId !== expectedChangeId ||
    !isDigest(output.recordId) ||
    !isDigest(output.requestDigest) ||
    output.investigationId !== `investigation-exemption-${output.recordId}` ||
    node.exactInputDigests.record !== output.recordId ||
    node.exactInputDigests.request !== output.requestDigest
  ) {
    throw refInvalid();
  }
  const applicability = readApplicabilityDependency(
    paths,
    node.provenanceParentNodeIds.applicability,
    node.semanticParentResultDigests.applicability,
  );
  return Object.freeze({
    ownerInvestigationId: output.investigationId,
    dependencies: Object.freeze([applicability]),
  });
}

export function assertProposeEvidenceNode(
  node: EvidenceNode,
  expected: {
    type: string;
    nodeSchema: string;
    outputSchema: string;
    exactInputKeys: string[];
    provenanceKeys: string[];
    semanticKeys: string[];
  },
): void {
  if (
    node.type !== expected.type ||
    node.nodeSchema !== expected.nodeSchema ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== expected.outputSchema ||
    !hasExactKeys(node.exactInputDigests, expected.exactInputKeys) ||
    !hasExactKeys(node.provenanceParentNodeIds, expected.provenanceKeys) ||
    !hasExactKeys(node.semanticParentResultDigests, expected.semanticKeys)
  ) {
    throw refInvalid();
  }
}

function readApplicabilityDependency(
  paths: InvestigationRuntimePaths,
  nodeId: string,
  resultDigest: string,
): InvestigationEvidenceDependencyClosureEntry {
  const node = readEvidenceNode(paths, nodeId);
  const applicability = assertInvestigationApplicability(node.output);
  if (
    applicability.kind !== 'investigation-exemption' ||
    node.type !== 'investigation-applicability' ||
    node.nodeSchema !== 'investigation.applicability.v1' ||
    node.evaluator !== 'investigation-applicability.v1' ||
    node.policyDigest !== INVESTIGATION_APPLICABILITY_POLICY_DIGEST ||
    node.outputSchema !== 'investigation.applicability-output.v1' ||
    node.resultDigest !== resultDigest
  ) {
    throw refInvalid();
  }
  return dependencyClosureEntry('applicability', node);
}

function readManifestAuthorityDependency(
  paths: InvestigationRuntimePaths,
  nodeId: string,
  resultDigest: string,
  expected: {
    changeId: string;
    investigationId: string;
    manifestDigest: string;
    investigationTargetDigest: string;
    sessionSnapshotDigest: string;
  },
): InvestigationEvidenceDependencyClosureEntry {
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  if (
    node.type !== 'investigation-manifest-authority' ||
    node.nodeSchema !== 'investigation.manifest-authority.v1' ||
    node.evaluator !== 'workflow-propose.manifest-authority.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== 'investigation.manifest-authority-output.v1' ||
    node.resultDigest !== resultDigest ||
    !hasExactKeys(node.exactInputDigests, [
      'manifest',
      'investigationTarget',
      'sessionSnapshot',
    ]) ||
    Object.keys(node.provenanceParentNodeIds).length !== 0 ||
    Object.keys(node.semanticParentResultDigests).length !== 0 ||
    !isPlainRecord(output) ||
    !hasExactKeys(output, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'manifestDigest',
      'investigationTargetDigest',
    ]) ||
    typeof output.repositoryId !== 'string' ||
    output.changeId !== expected.changeId ||
    output.investigationId !== expected.investigationId ||
    !Number.isSafeInteger(output.sessionRevision) ||
    Number(output.sessionRevision) < 0 ||
    output.manifestDigest !== expected.manifestDigest ||
    output.investigationTargetDigest !== expected.investigationTargetDigest ||
    output.sessionSnapshotDigest !== expected.sessionSnapshotDigest ||
    node.exactInputDigests.manifest !== output.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      output.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !== output.sessionSnapshotDigest
  ) {
    throw refInvalid();
  }
  return dependencyClosureEntry('manifest-authority', node);
}

export function dependencyClosureEntry(
  role: string,
  node: EvidenceNode,
): InvestigationEvidenceDependencyClosureEntry {
  return Object.freeze({
    role,
    nodeId: node.nodeId,
    resultDigest: node.resultDigest,
    envelopeDigest: sha256(canonicalEvidenceNodeEnvelope(node)),
  });
}
