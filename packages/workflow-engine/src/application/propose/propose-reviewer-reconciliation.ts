/**
 * Reconciles planning artifacts after reviewer terms produce a resealed investigation.
 *
 * Invariants:
 * - Prior review snapshots authenticate old bytes and the resealed session derives next bytes.
 * - Before receipt CAS, each managed artifact contains authenticated old or exact next bytes.
 * - Receipt CAS is the commit point; later failures never roll the live artifacts back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { readPlanReviewTargetSnapshotNode } from '../../modules/assurance/plan-review.ts';
import {
  type InvestigationFirstPlanningSubject,
  deriveInvestigationFirstPlanningSubject,
} from '../../modules/assurance/planning-assurance-validator.ts';
import { projectInvestigationManifestLedger } from '../../modules/projection/investigation-design-projection.ts';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import { preparePlanReviewInvocation } from './plan-review-preparation.ts';
import { readPlanReviewReservation } from './plan-review-store.ts';
import {
  assertReviewerReconciliationLiveArtifacts,
  fsyncReviewerReconciliationDirectory,
  readReviewerReconciliationSnapshotContents,
  reclaimReviewerReconciliationTemporaries,
} from './propose-artifacts.ts';
import {
  PLANNING_MATERIALIZATION_REF,
  hasExactKeys,
  isDigestRecord,
  isRecord,
  planningMaterializationStale,
  sha256,
} from './propose-common.ts';
import { withProposeTransitionAuthority } from './propose-context.ts';
import {
  createInvestigationManifestAuthorityNode,
  readInvestigationManifestAuthorityNode,
} from './propose-evidence.ts';
import { assertGuardContribution } from './propose-input.ts';
import { rebuildInvestigation } from './propose-investigation-rebuild.ts';
import {
  currentPlanningSchemaName,
  indexBehaviorContracts,
  persistPlanningMaterializationReceipt,
  readPlanningMaterializationReceipt,
} from './propose-planning-store.ts';
import { dispatchPreparedPlanReview } from './propose-provider-lifecycle.ts';
import {
  preparePlanningScaffold,
  publishTrackedInvestigationManifestV3,
} from './propose-publication.ts';
import type {
  ChangeContract,
  InvestigationStatus,
  ProposeRuntime,
} from './propose-runtime.ts';
import { getProposeStatus } from './propose-status.ts';
import {
  type ProposeOutput,
  type ProposeResumeOptions,
  type ReviewerReconciliationMaterializationReceipt,
} from './propose-types.ts';

export function reconcileReviewerTermPlanningRevision(
  services: ProposeRuntime,
  cwd: string,
  status: InvestigationStatus,
  options: ProposeResumeOptions,
): ProposeOutput {
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  withProposeTransitionAuthority(
    services,
    cwd,
    initialContext.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const current = services.investigation.getInvestigationStatus(
        cwd,
        status.investigationId,
      );
      if (current.state !== 'investigation-sealed') {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'Reviewer-term planning reconciliation requires the resealed investigation.',
          ExitCode.staleState,
        );
      }
      const context = services.workspace.loadInvestigationRuntimeContext(cwd);
      const rebuilt = rebuildInvestigation(
        services,
        cwd,
        current.investigationId,
        'consume',
        options.collaborationGrantValidation,
        assertOwned,
      );
      if (rebuilt.reviewerTermSourceNode === null) {
        throw workflowError(
          'INVESTIGATION_REVIEWER_REOPEN_STALE',
          'The resealed investigation has no reviewer-term source.',
          ExitCode.staleState,
        );
      }
      const receipt = readReviewerReconciliationMaterializationReceipt(
        services,
        context.runtime,
        current,
      );
      const changeDirectory = path.join(
        context.git.repositoryRoot,
        context.config.changeRoot,
        current.changeId,
      );
      const scaffold = preparePlanningScaffold(
        services,
        cwd,
        current,
        rebuilt,
        rebuilt.session.createdAt.slice(0, 10),
        true,
        false,
      );
      const publishCurrentScaffold = () => {
        const assertCurrent = () => {
          const observed = services.investigation.readInvestigationSession(
            context.runtime,
            rebuilt.session.investigationId,
          );
          if (canonicalJson(observed) !== canonicalJson(rebuilt.session)) {
            throw workflowError(
              'PROPOSE_INPUT_STALE',
              'Investigation changed during reviewer-term Manifest publication.',
              ExitCode.staleState,
            );
          }
        };
        publishTrackedInvestigationManifestV3(services, {
          context,
          manifest: scaffold.investigationManifest,
          assertOwned,
          assertCurrent,
        });
      };
      // The prior PlanReview reservation/review-root authenticates old bytes,
      // the sealed session projection derives exact next bytes, and the
      // materialization-ref CAS is the commit point. Before that CAS only old
      // or next bytes may exist; after it, retries require exact next bytes and
      // never roll live files back after a downstream error.
      let currentArtifacts: Record<string, string>;
      if (receipt.matchesCurrentSession) {
        const sealedArtifacts = readPlanningMaterializationReceipt(
          services,
          context.runtime,
          current,
          createInvestigationManifestAuthorityNode(
            rebuilt,
            scaffold.investigationManifest,
          ),
        );
        if (sealedArtifacts === null) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation lost its current materialization.',
          );
        }
        assertOwned();
        const sealedLiveArtifacts = assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          sealedArtifacts,
          sealedArtifacts,
        );
        const sealedBytes = new Map(
          [...sealedLiveArtifacts.entries()].map(([relativePath, artifact]) => [
            relativePath,
            artifact.text,
          ]),
        );
        reclaimReviewerReconciliationTemporaries(
          changeDirectory,
          sealedBytes,
          sealedBytes,
        );
        assertOwned();
        assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          sealedArtifacts,
          sealedArtifacts,
        );
        if (
          sealedArtifacts['investigation.json'] !==
          sha256(scaffold.investigationBytes)
        ) {
          throw planningMaterializationStale(
            'Current reviewer-term materialization does not match the resealed investigation.',
          );
        }
        publishCurrentScaffold();
        currentArtifacts = sealedArtifacts;
      } else {
        const previousArtifacts = readReviewerReconciliationSnapshotArtifacts(
          services,
          context.runtime,
          context.config.changeRoot,
          current,
          receipt,
        );
        const previousDesign = previousArtifacts.get('design.md');
        if (
          previousDesign === undefined ||
          !previousArtifacts.has('investigation.json')
        ) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation snapshot is missing a managed target.',
          );
        }
        if (scaffold.investigationManifest.applicability.kind !== 'ordinary') {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation requires an ordinary v3 Manifest.',
          );
        }
        const nextDesign = projectInvestigationManifestLedger(
          previousDesign,
          scaffold.investigationManifest.applicability.semanticDelta
            .whyOverlays,
        );
        const nextBytes = new Map(previousArtifacts);
        nextBytes.set('investigation.json', scaffold.investigationBytes);
        nextBytes.set('design.md', nextDesign);
        const nextArtifacts = Object.fromEntries(
          [...nextBytes.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([relativePath, content]) => [relativePath, sha256(content)]),
        );
        assertOwned();
        reclaimReviewerReconciliationTemporaries(
          changeDirectory,
          previousArtifacts,
          nextBytes,
        );
        assertOwned();
        const liveArtifacts = assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          receipt.artifacts,
          nextArtifacts,
        );
        const nextDesignContent = nextBytes.get('design.md');
        const liveDesign = liveArtifacts.get('design.md');
        if (nextDesignContent === undefined || liveDesign === undefined) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation lost a managed target.',
          );
        }
        publishCurrentScaffold();
        if (liveDesign.digest !== nextArtifacts['design.md']) {
          services.workspace.replaceTextAtomic(
            path.join(changeDirectory, 'design.md'),
            nextDesignContent,
            { allowCreate: false },
          );
        }
        assertReviewerReconciliationLiveArtifacts(
          changeDirectory,
          nextArtifacts,
          nextArtifacts,
        );
        fsyncReviewerReconciliationDirectory(changeDirectory);
        persistPlanningMaterializationReceipt(
          services,
          context.runtime,
          current,
          createInvestigationManifestAuthorityNode(
            rebuilt,
            scaffold.investigationManifest,
          ),
          nextArtifacts,
          receipt.nodeId,
        );
        currentArtifacts = nextArtifacts;
      }
      const planning = derivePlanningSubjectFromCurrentDraft(
        services,
        cwd,
        current,
        scaffold.investigationBytes,
        currentArtifacts,
      );
      preparePlanReviewInvocation(
        services,
        cwd,
        current,
        planning,
        options.collaborationGrant,
        options.roleTopologyResolution,
        options.roleContextSharingGrant,
        assertOwned,
      );
      assertOwned();
    },
  );
  let output = getProposeStatus(
    services,
    cwd,
    status.investigationId,
    options.collaborationGrantValidation,
  );
  dispatchPreparedPlanReview(services, cwd, output, options);
  output = getProposeStatus(
    services,
    cwd,
    status.investigationId,
    options.collaborationGrantValidation,
  );
  return output;
}

function readReviewerReconciliationMaterializationReceipt(
  services: Pick<ProposeRuntime, 'evidence'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: InvestigationStatus,
): ReviewerReconciliationMaterializationReceipt {
  const nodeId = services.evidence.readEvidenceRefs(paths, status.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (!nodeId) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation has no planning materialization.',
    );
  }
  const node = services.evidence.readEvidenceNode(paths, nodeId);
  const output = node.output;
  const authorityNodeId = node.provenanceParentNodeIds.manifestAuthority;
  const authority =
    typeof authorityNodeId === 'string'
      ? readInvestigationManifestAuthorityNode(
          services.evidence.readEvidenceNode(paths, authorityNodeId),
        )
      : null;
  const boundRevision = isRecord(output) ? output.semanticRevision : null;
  if (
    node.type !== 'propose-planning-materialization' ||
    node.nodeSchema !== 'workflow.propose-planning-materialization.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-planning-materialization-output.v3' ||
    authority === null ||
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
    !Number.isSafeInteger(boundRevision) ||
    Number(boundRevision) < 0 ||
    Number(boundRevision) > status.semanticRevision ||
    canonicalJson(output.baseline) !== canonicalJson(status.baseline) ||
    !isDigestRecord(output.artifacts) ||
    output.manifestAuthorityNodeId !== authorityNodeId ||
    output.manifestAuthorityResultDigest !==
      node.semanticParentResultDigests.manifestAuthority ||
    output.manifestDigest !== authority.manifestDigest ||
    output.investigationTargetDigest !== authority.investigationTargetDigest ||
    output.sessionSnapshotDigest !== authority.sessionSnapshotDigest ||
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
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(status.baseline)) ||
    node.exactInputDigests.manifestAuthority !== authorityNodeId ||
    node.exactInputDigests.manifest !== authority.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      authority.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !== authority.sessionSnapshotDigest
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation materialization is invalid or stale.',
    );
  }
  return {
    nodeId,
    node,
    matchesCurrentSession: Number(boundRevision) === status.semanticRevision,
    artifacts: output.artifacts as Record<string, string>,
  };
}

function readReviewerReconciliationSnapshotArtifacts(
  services: Pick<ProposeRuntime, 'evidence' | 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  changeRoot: string,
  status: InvestigationStatus,
  receipt: ReviewerReconciliationMaterializationReceipt,
): Map<string, string> {
  const reservation = readPlanReviewReservation(services, paths, status);
  if (
    reservation === null ||
    reservation.materializationNode.nodeId !== receipt.nodeId ||
    canonicalJson(reservation.materializationNode) !==
      canonicalJson(receipt.node)
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview does not bind the current old materialization.',
    );
  }
  const durableManifest = services.provider.readProviderInvocationManifest(
    paths,
    reservation.request.invocationId,
  );
  const durableRequest = services.provider.readProviderInvocationRequest(
    paths,
    reservation.request.invocationId,
  );
  const snapshotRuntime = services.provider.readPlanReviewSnapshotRuntime(
    paths,
    reservation.request.invocationId,
  );
  if (
    snapshotRuntime === null ||
    canonicalJson(durableManifest) !== canonicalJson(reservation.manifest) ||
    canonicalJson(durableRequest) !== canonicalJson(reservation.request) ||
    canonicalJson(reservation.manifest.planningTarget) !==
      canonicalJson(
        readPlanReviewTargetSnapshotNode(reservation.targetSnapshotNode),
      )
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview snapshot binding is missing or stale.',
    );
  }
  return readReviewerReconciliationSnapshotContents(
    snapshotRuntime.root,
    `${changeRoot}/${status.changeId}/`,
    reservation.manifest.planningTarget.artifacts,
    receipt.artifacts,
  );
}

function derivePlanningSubjectFromCurrentDraft(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  status: InvestigationStatus,
  investigationBytes: string,
  artifactDigestMap: Record<string, string>,
): InvestigationFirstPlanningSubject {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    status.changeId,
  );
  const tasks = services.workspace.parseTasks(
    fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
  );
  const guard = assertGuardContribution(
    JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
    ),
    status.changeId,
    tasks.map(({ id }) => id),
    Object.keys(
      services.workspace.loadChecksConfig(context.git.repositoryRoot).checks,
    ),
  );
  const specs = Object.keys(artifactDigestMap)
    .filter((relativePath) => relativePath.startsWith('specs/'))
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      content: fs.readFileSync(
        path.join(changeDirectory, relativePath),
        'utf8',
      ),
    }));
  const behaviorContracts = indexBehaviorContracts(specs);
  const execution = services.workspace.parseExecutionArtifact(
    JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'execution.json'), 'utf8'),
    ),
    status.changeId,
    tasks,
    guard,
    services.workspace.loadChecksConfig(context.git.repositoryRoot),
    behaviorContracts,
  );
  const investigation = services.workspace.parseCurrentInvestigationManifest(
    JSON.parse(investigationBytes),
    status.changeId,
    {
      repositoryRoot: context.git.repositoryRoot,
      expectedRepositoryId: context.config.repositoryName,
      artifactPath: path.join(changeDirectory, 'investigation.json'),
    },
  );
  const checks = services.workspace.loadChecksConfig(
    context.git.repositoryRoot,
  );
  const contract: ChangeContract = {
    changeId: status.changeId,
    changeDirectory,
    schemaName: currentPlanningSchemaName(context.git.repositoryRoot),
    config: context.config,
    checks,
    guard,
    tasks,
    behaviorContracts,
    investigation,
    execution,
    artifactPaths: Object.keys(artifactDigestMap).map((relativePath) =>
      path.join(changeDirectory, relativePath),
    ),
    artifactDigests: Object.fromEntries(
      Object.entries(artifactDigestMap).map(([relativePath, digest]) => [
        path.join(changeDirectory, relativePath),
        digest,
      ]),
    ),
  };
  return deriveInvestigationFirstPlanningSubject(
    context.git.repositoryRoot,
    contract,
  );
}
