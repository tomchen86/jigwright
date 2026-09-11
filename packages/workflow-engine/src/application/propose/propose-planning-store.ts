/**
 * Binds materialized planning bytes to durable receipts and derived plan summaries.
 *
 * Invariants:
 * - Receipts bind artifact digests to the current manifest or structured applicability.
 * - Receipt advancement preserves expected current evidence and revision ownership.
 * - Live artifacts and their OpenSpec graph match the receipt before they are reported.
 */

import { extractFileHeader } from '../../modules/source/file-header.ts';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type WorkflowPlanDigest,
  type WorkflowPlanDigestTouchedFile,
} from '../../modules/guidance/renderers/plan-digest.ts';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import { loadRepositoryConsumerConfiguration } from '../../runtime/repository-observation/repository-consumer.ts';
import {
  assertRequiredPlanningArtifacts,
  readMaterializedPlanningArtifactDigests,
  readPlanDigestFromArtifacts,
  requiredPlanningArtifactPaths,
} from './propose-artifacts.ts';
import {
  hasExactKeys,
  isDigestRecord,
  isRecord,
  PLANNING_MATERIALIZATION_REF,
  planningMaterializationStale,
  sha256,
} from './propose-common.ts';
import { assertCurrentGovernanceSources } from './propose-context.ts';
import {
  createExemptionPlanningMaterializationNode,
  createInvestigationManifestAuthorityNode,
  createPlanningMaterializationNode,
  readInvestigationManifestAuthorityNode,
} from './propose-evidence.ts';
import {
  buildProposeInvestigationManifestV3,
  investigationV3BuildFailure,
} from './propose-investigation-manifest.ts';
import type {
  BehaviorContractRef,
  EvidenceNode,
  InvestigationStatus,
  ProposeExemptionSession,
  ProposeRuntime,
} from './propose-runtime.ts';
import { type RebuiltInvestigation } from './propose-types.ts';

export function projectOrdinaryPlanDigest(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  rebuilt: RebuiltInvestigation,
): WorkflowPlanDigest {
  const freshWhyByPath = new Map(
    (rebuilt.whyAuthoring?.whyOverlays ?? []).flatMap((why) => {
      return why.pathIdentity.utf8 === null
        ? []
        : [
            [
              why.pathIdentity.utf8,
              {
                path: why.pathIdentity.utf8,
                why: why.why,
                protectedInvariant: why.protectedInvariant,
              },
            ] as const,
          ];
    }),
  );
  const manifestById = new Map(
    rebuilt.completeFullBlobManifest.map((entry) => [
      entry.manifestEntryId,
      entry,
    ]),
  );
  const carriedWhyByPath = new Map<string, WorkflowPlanDigestTouchedFile>();
  const repositoryRoot =
    services.workspace.loadInvestigationRuntimeContext(cwd).git.repositoryRoot;
  for (const carried of rebuilt.reuseCoverage.carried) {
    const manifest = manifestById.get(carried.manifestEntryId);
    const pathValue = manifest?.path.utf8;
    if (pathValue === undefined || pathValue === null) continue;
    const header = extractFileHeader(
      services.workspace.readFileAtCommit(
        repositoryRoot,
        rebuilt.session.baseline.head,
        pathValue,
      ) ?? '',
    );
    if (header === null || header.invariants.length === 0) continue;
    carriedWhyByPath.set(pathValue, {
      path: pathValue,
      why: header.responsibility,
      protectedInvariant:
        header.invariants.join('; ') ||
        'Preserve the exact reviewed behavior of this planned mutation.',
    });
  }
  return projectPlanDigestFromCurrentArtifacts(
    services,
    cwd,
    rebuilt.session.changeId,
    rebuilt.intent.explicitPaths.map((pathValue) =>
      planDigestTouchedFile(
        pathValue,
        freshWhyByPath.get(pathValue) ?? carriedWhyByPath.get(pathValue),
      ),
    ),
  );
}

export function projectExemptionPlanDigest(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  session: ProposeExemptionSession,
): WorkflowPlanDigest {
  return projectPlanDigestFromCurrentArtifacts(
    services,
    cwd,
    session.changeId,
    session.intent.explicitPaths.map((pathValue) =>
      planDigestTouchedFile(pathValue),
    ),
  );
}

function planDigestTouchedFile(
  pathValue: string,
  semanticWhy?: WorkflowPlanDigestTouchedFile,
): WorkflowPlanDigestTouchedFile {
  return (
    semanticWhy ?? {
      path: pathValue,
      why: 'No load-bearing investigation WHY row was required; this exact planned mutation remains bound to PlanReview coverage.',
      protectedInvariant:
        'Preserve the exact reviewed behavior of this planned mutation.',
    }
  );
}

function projectPlanDigestFromCurrentArtifacts(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  changeId: string,
  touchedFilesAndWhy: readonly WorkflowPlanDigestTouchedFile[],
): WorkflowPlanDigest {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    changeId,
  );
  return readPlanDigestFromArtifacts(changeDirectory, touchedFilesAndWhy);
}

export function persistPlanningMaterializationReceipt(
  services: Pick<ProposeRuntime, 'evidence' | 'investigation'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: InvestigationStatus,
  manifestAuthorityNode: EvidenceNode,
  artifacts: Record<string, string>,
  expectedCurrentNodeId?: string,
): void {
  const node = createPlanningMaterializationNode(
    status,
    manifestAuthorityNode,
    artifacts,
  );
  services.evidence.writeEvidenceNode(paths, manifestAuthorityNode);
  services.evidence.writeEvidenceNode(paths, node);
  const current =
    services.evidence.readEvidenceRefs(paths, status.changeId)[
      PLANNING_MATERIALIZATION_REF
    ] ?? null;
  if (current === node.nodeId) {
    return;
  }
  if (
    expectedCurrentNodeId !== undefined &&
    current !== expectedCurrentNodeId
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation materialization changed before receipt advancement.',
    );
  }
  const reviewerRevision =
    services.investigation.readInvestigationSession(
      paths,
      status.investigationId,
    ).milestones.reviewerTermSourceNodeId !== null;
  if (current !== null && !reviewerRevision) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  services.evidence.compareAndSwapEvidenceRef(paths, {
    changeId: status.changeId,
    refName: PLANNING_MATERIALIZATION_REF,
    expectedNodeId: expectedCurrentNodeId ?? current,
    nextNodeId: node.nodeId,
  });
}

export function persistExemptionPlanningMaterializationReceipt(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  session: ProposeExemptionSession,
  artifacts: Record<string, string>,
): void {
  const node = createExemptionPlanningMaterializationNode(session, artifacts);
  services.evidence.writeEvidenceNode(paths, node);
  const current =
    services.evidence.readEvidenceRefs(paths, session.changeId)[
      PLANNING_MATERIALIZATION_REF
    ] ?? null;
  if (current === node.nodeId) {
    return;
  }
  if (current !== null) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_CONFLICT',
      'A different planning materialization is already current.',
      ExitCode.conflict,
    );
  }
  services.evidence.compareAndSwapEvidenceRef(paths, {
    changeId: session.changeId,
    refName: PLANNING_MATERIALIZATION_REF,
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });
}

export function readPlanningMaterializationReceipt(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: InvestigationStatus,
  manifestAuthorityNode: EvidenceNode,
): Record<string, string> | null {
  const nodeId = services.evidence.readEvidenceRefs(paths, status.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (nodeId === undefined) {
    return null;
  }
  const node = services.evidence.readEvidenceNode(paths, nodeId);
  const output = node.output;
  const authority = readInvestigationManifestAuthorityNode(
    manifestAuthorityNode,
  );
  if (
    node.type !== 'propose-planning-materialization' ||
    node.nodeSchema !== 'workflow.propose-planning-materialization.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-planning-materialization-output.v3' ||
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
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    output.semanticRevision !== status.semanticRevision ||
    canonicalJson(output.baseline) !== canonicalJson(status.baseline) ||
    output.manifestAuthorityNodeId !== manifestAuthorityNode.nodeId ||
    output.manifestAuthorityResultDigest !==
      manifestAuthorityNode.resultDigest ||
    output.manifestDigest !== authority.manifestDigest ||
    output.investigationTargetDigest !== authority.investigationTargetDigest ||
    output.sessionSnapshotDigest !== authority.sessionSnapshotDigest ||
    !isDigestRecord(output.artifacts) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(status.baseline)) ||
    node.exactInputDigests.manifestAuthority !== manifestAuthorityNode.nodeId ||
    node.exactInputDigests.manifest !== authority.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      authority.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !==
      authority.sessionSnapshotDigest ||
    node.provenanceParentNodeIds.manifestAuthority !==
      manifestAuthorityNode.nodeId ||
    node.semanticParentResultDigests.manifestAuthority !==
      manifestAuthorityNode.resultDigest
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Durable planning materialization evidence is invalid or stale.',
      ExitCode.staleState,
    );
  }
  return output.artifacts as Record<string, string>;
}

export function readExemptionPlanningMaterializationReceipt(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  session: ProposeExemptionSession,
): Record<string, string> | null {
  const nodeId = services.evidence.readEvidenceRefs(paths, session.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (nodeId === undefined) {
    return null;
  }
  const node = services.evidence.readEvidenceNode(paths, nodeId);
  const output = node.output;
  if (
    node.type !== 'propose-exemption-planning-materialization' ||
    node.nodeSchema !==
      'workflow.propose-exemption-planning-materialization.v1' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-exemption-planning-materialization-output.v1' ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'revision',
      'baseline',
      'artifacts',
      'applicabilityNodeId',
      'applicabilityResultDigest',
    ]) ||
    output.investigationId !== session.investigationId ||
    output.changeId !== session.changeId ||
    output.revision !== session.revision ||
    canonicalJson(output.baseline) !== canonicalJson(session.baseline) ||
    output.applicabilityNodeId !== session.applicabilityNode.nodeId ||
    output.applicabilityResultDigest !==
      session.applicabilityNode.resultDigest ||
    !isDigestRecord(output.artifacts) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(session.baseline)) ||
    node.exactInputDigests.applicability !== session.applicabilityNode.nodeId ||
    node.provenanceParentNodeIds.applicability !==
      session.applicabilityNode.nodeId ||
    node.semanticParentResultDigests.applicability !==
      session.applicabilityNode.resultDigest
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Durable exemption planning materialization evidence is invalid or stale.',
      ExitCode.staleState,
    );
  }
  return output.artifacts as Record<string, string>;
}

export function readMaterializedPlanningArtifacts(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'workspace' | 'roleContextSharingGrants'
  >,
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  scaffold: {
    changeDirectory: string;
    investigationBytes: string;
  },
): Record<string, string> | null {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const manifest = buildProposeInvestigationManifestV3(
    services.workspace.materializeInvestigationEvidenceView,
    services.roleContextSharingGrants,
    context,
    rebuilt,
  );
  if (manifest.outcome !== 'built') {
    throw investigationV3BuildFailure(manifest.blocker);
  }
  const receipt = readPlanningMaterializationReceipt(
    services,
    context.runtime,
    status,
    createInvestigationManifestAuthorityNode(rebuilt, manifest.manifest),
  );
  if (receipt === null) {
    return null;
  }
  assertCurrentGovernanceSources(
    services,
    context.git.repositoryRoot,
    rebuilt.intent.sourceRefs,
  );
  const required = requiredPlanningArtifactPaths(
    rebuilt.intent.sourceRefs.length > 0,
  );
  assertRequiredPlanningArtifacts(
    scaffold.changeDirectory,
    required,
    'A required planning artifact is missing from the durable materialization.',
  );
  const hasPlanReview = fs.existsSync(
    path.join(scaffold.changeDirectory, 'plan-review.json'),
  );
  const authoring = services.workspace.planningProviderAuthoring(context);
  const providerStatus = authoring.inspectStatus(
    status.changeId,
    currentPlanningSchemaName(context.git.repositoryRoot),
  );
  if (
    (hasPlanReview && !providerStatus.isComplete) ||
    (!hasPlanReview && providerStatus.isComplete) ||
    providerStatus.artifacts.find(({ id }) => id === 'plan-review')?.status !==
      (hasPlanReview ? 'done' : 'ready')
  ) {
    throw planningMaterializationStale(
      'OpenSpec no longer observes the receipt-bound review-pending graph.',
    );
  }
  const observed = readMaterializedPlanningArtifactDigests(
    scaffold.changeDirectory,
    required,
  );
  if (canonicalJson(observed) !== canonicalJson(receipt)) {
    throw planningMaterializationStale(
      'Current planning bytes differ from durable materialization evidence.',
    );
  }
  return observed;
}

export function readMaterializedExemptionPlanningArtifacts(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'workspace' | 'roleContextSharingGrants'
  >,
  cwd: string,
  session: ProposeExemptionSession,
  changeDirectory: string,
): Record<string, string> {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const receipt = readExemptionPlanningMaterializationReceipt(
    services,
    context.runtime,
    session,
  );
  if (receipt === null) {
    throw planningMaterializationStale(
      'Structured exemption planning has no durable materialization receipt.',
    );
  }
  assertCurrentGovernanceSources(
    services,
    context.git.repositoryRoot,
    session.intent.sourceRefs,
  );
  const required = requiredPlanningArtifactPaths(
    session.intent.sourceRefs.length > 0,
  );
  assertRequiredPlanningArtifacts(
    changeDirectory,
    required,
    'A required exemption planning artifact is missing from the durable materialization.',
  );
  const hasPlanReview = fs.existsSync(
    path.join(changeDirectory, 'plan-review.json'),
  );
  const authoring = services.workspace.planningProviderAuthoring(context);
  const providerStatus = authoring.inspectStatus(
    session.changeId,
    currentPlanningSchemaName(context.git.repositoryRoot),
  );
  if (
    (hasPlanReview && !providerStatus.isComplete) ||
    (!hasPlanReview && providerStatus.isComplete) ||
    providerStatus.artifacts.find(({ id }) => id === 'plan-review')?.status !==
      (hasPlanReview ? 'done' : 'ready')
  ) {
    throw planningMaterializationStale(
      'OpenSpec no longer observes the receipt-bound exemption review graph.',
    );
  }
  const observed = readMaterializedPlanningArtifactDigests(
    changeDirectory,
    required,
  );
  if (canonicalJson(observed) !== canonicalJson(receipt)) {
    throw planningMaterializationStale(
      'Current exemption planning bytes differ from durable materialization evidence.',
    );
  }
  return observed;
}

/** Create the managed entries that do not exist yet. */
export function writeManagedEntries(
  services: Pick<ProposeRuntime, 'workspace'>,
  changeDirectory: string,
  entries: Map<string, string>,
): void {
  for (const [relativePath, content] of entries) {
    const target = path.join(changeDirectory, relativePath);
    if (!fs.existsSync(target)) {
      services.workspace.replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
    }
  }
}

export function indexBehaviorContracts(
  specs: Array<{ path: string; content: string }>,
): BehaviorContractRef[] {
  const refs: BehaviorContractRef[] = [];
  for (const spec of specs) {
    let requirement: string | null = null;
    for (const line of spec.content.split('\n')) {
      const requirementMatch = /^### Requirement: (.+)$/.exec(line);
      if (requirementMatch) {
        requirement = requirementMatch[1]!.trim();
        refs.push({
          specPath: spec.path,
          requirement,
          scenario: null,
        });
        continue;
      }
      const scenarioMatch = /^#### Scenario: (.+)$/.exec(line);
      if (scenarioMatch && requirement) {
        refs.push({
          specPath: spec.path,
          requirement,
          scenario: scenarioMatch[1]!.trim(),
        });
      }
    }
  }
  return refs.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

export function currentPlanningSchemaName(repositoryRoot: string): string {
  return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
    .planning.currentSchemaName;
}
